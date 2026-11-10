/**
 * MCP client — the single owner of every external connection.
 *
 * Exactly one instance exists per app run (`getManager()`), because the
 * lifecycle rules only stay true with a single owner:
 *
 *   - a child process per enabled server, reaped on disable/remove/config
 *     change/app quit (M9);
 *   - one alias → {serverId, originalName} registry, built from the live tool
 *     tables, so the renderer never has to reverse-engineer a truncated name;
 *   - one place that turns "the server is gone" into a structured tool result
 *     instead of an exception inside the agent loop.
 *
 * The manager knows nothing about the 36 built-in tools: it accepts their names
 * in `getToolSet()`, where they win every collision (design §2.5, M5).
 */

const {
  validateMcpServers,
  connectionSignature,
  MAX_SERVERS
} = require('./config-validate')
const { StdioTransport } = require('./stdio-transport')
const { HttpTransport } = require('./http-transport')
const { McpSession } = require('./session')
const { buildServerAliases } = require('./tool-name')
const { toOpenAIParameters, validateArgs, LIMITS } = require('./schema-slim')
const { McpRpcError, normalizeError, ERR } = require('./rpc')

const MAX_DESCRIPTION_CHARS = 1024

/**
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
function clip (text, max = MAX_DESCRIPTION_CHARS) {
  const s = String(text || '')
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/**
 * Approval hint for the renderer (design D1): `ask` means "everything that is
 * not declared read-only needs a confirmation".
 * @param {{trust: string, annotations: object}} entry
 * @returns {boolean}
 */
function needsApprovalFor (entry) {
  const trust = entry.trust || 'ask'
  if (trust === 'auto') {
    return false
  }
  const readOnly = !!(entry.annotations && entry.annotations.readOnlyHint === true)
  return !readOnly
}

class McpClientManager {
  /**
   * @param {{
   *   getServers?: Function, log?: Function, spawnImpl?: Function,
   *   fetchImpl?: Function, transportFactory?: Function,
   *   clientInfo?: object, limits?: object, maxServers?: number
   * }} [opts]
   */
  constructor ({
    getServers = null,
    log = null,
    spawnImpl = undefined,
    fetchImpl = null,
    transportFactory = null,
    clientInfo = {},
    limits = LIMITS,
    maxServers = MAX_SERVERS
  } = {}) {
    this.getServers = getServers
    this.log = typeof log === 'function' ? log : () => {}
    this.spawnImpl = spawnImpl
    this.fetchImpl = fetchImpl
    this.transportFactory = transportFactory
    this.clientInfo = clientInfo
    this.limits = { ...LIMITS, ...limits }
    this.maxServers = maxServers
    this.configs = []
    // Validation problems from the last syncConfig(), in structured form so the
    // settings UI can point at the offending row/field (strings go to `warnings`).
    this.configErrors = []
    // serverId → { session, config, signature }
    this.sessions = new Map()
    // alias → registry entry (the only reverse map that exists)
    this.registry = new Map()
    this.warnings = []
  }

  /**
   * Reconcile our connections with a configuration list.
   * @param {Array} servers raw `mcpServersAI`
   * @returns {Promise<Array<object>>} state snapshot
   */
  async syncConfig (servers) {
    const validated = validateMcpServers(servers)
    this.warnings = validated.warnings.slice()
    this.configErrors = validated.errors.slice()
    for (const error of validated.errors) {
      this._warn(`config error at index ${error.index} field ${error.field}: ${error.message}`)
    }
    this.configs = validated.servers.slice(0, this.maxServers)

    const alive = new Set()
    for (const config of this.configs) {
      alive.add(config.id)
      const record = this.sessions.get(config.id)
      if (!config.enabled) {
        if (record) {
          await this.disconnect(config.id, 'disabled')
        }
        continue
      }
      if (!record) {
        if (config.autoConnect !== false) {
          await this.connect(config.id).catch((err) => {
            this._warn(`connect failed for ${config.id}: ${err.message}`)
          })
        }
        continue
      }
      if (record.signature !== connectionSignature(config)) {
        await this.disconnect(config.id, 'config-changed')
        await this.connect(config.id).catch((err) => {
          this._warn(`reconnect failed for ${config.id}: ${err.message}`)
        })
      } else {
        // timeout/trust/name changes take effect without restarting the child
        record.config = config
        record.session.serverConfig = config
      }
    }

    for (const id of Array.from(this.sessions.keys())) {
      if (!alive.has(id)) {
        await this.disconnect(id, 'removed')
      }
    }

    this._refreshRegistry()
    return this.getState()
  }

  /**
   * @param {string} serverId
   * @returns {Promise<object>} session state
   */
  async connect (serverId) {
    const config = this.configs.find(item => item.id === serverId)
    if (!config) {
      throw new McpRpcError(ERR.UNAVAILABLE, `unknown MCP server: ${serverId}`, { serverId })
    }
    const existing = this.sessions.get(serverId)
    if (existing && existing.session.state === 'ready') {
      return existing.session.getState()
    }
    if (existing) {
      await this.disconnect(serverId, 'reconnect')
    }
    const session = this._createSession(config)
    const record = {
      session,
      config,
      signature: connectionSignature(config)
    }
    this.sessions.set(serverId, record)
    try {
      await session.connect()
      this._info(`connected ${config.name} (${config.transport}) protocol=${session.protocolVersion} tools=${session.tools.length}`)
    } catch (err) {
      const error = normalizeError(err)
      this._warn(`connect failed for ${config.name}: ${error.message}`)
      // keep the record: the UI shows "failed" with a retry button
      this._refreshRegistry()
      throw error
    }
    this._refreshRegistry()
    return session.getState()
  }

  /**
   * @param {string} serverId
   * @param {string} [reason]
   * @returns {Promise<void>}
   */
  async disconnect (serverId, reason = 'user') {
    const record = this.sessions.get(serverId)
    if (!record) {
      return
    }
    this.sessions.delete(serverId)
    try {
      await record.session.close(reason)
    } catch (err) {
      this._warn(`close failed for ${serverId}: ${err.message}`)
    }
    this._refreshRegistry()
  }

  /**
   * @param {string} serverId
   * @returns {Promise<object>}
   */
  async restart (serverId) {
    await this.disconnect(serverId, 'restart')
    return this.connect(serverId)
  }

  /**
   * @returns {Array<object>} one entry per configured server
   */
  getState () {
    const states = []
    for (const config of this.configs) {
      const record = this.sessions.get(config.id)
      if (record) {
        states.push(record.session.getState())
      } else {
        states.push({
          id: config.id,
          name: config.name,
          transport: config.transport,
          trust: config.trust,
          state: config.enabled ? 'idle' : 'closed',
          protocolVersion: '',
          toolCount: 0,
          toolsTruncated: false,
          lastError: '',
          serverInfo: { name: '', version: '' },
          pending: 0
        })
      }
    }
    return states
  }

  /**
   * Build the provider-ready tool list plus its reverse map.
   * @param {{builtinToolNames?: string[]|Set<string>}} [opts] names that win collisions
   * @returns {{openaiTools: Array, meta: object, servers: Array,
   *   truncated: {perServer: number, global: number}}}
   */
  getToolSet (opts = {}) {
    const builtin = new Set(
      Array.from(opts.builtinToolNames || []).map(name => String(name).toLowerCase())
    )
    const openaiTools = []
    const meta = {}
    let globalTruncated = 0
    let perServerTruncated = 0

    for (const entry of this.registry.values()) {
      if (openaiTools.length >= this.limits.globalTools) {
        globalTruncated++
        continue
      }
      if (builtin.has(entry.alias)) {
        // 内置优先：never overwrite a tool the model already knows
        this._warn(`tool name collides with a built-in tool, skipped: ${entry.alias}`)
        continue
      }
      if (entry.overPerServerLimit) {
        perServerTruncated++
        continue
      }
      openaiTools.push({
        type: 'function',
        function: {
          name: entry.alias,
          description: clip(entry.description),
          parameters: entry.parameters
        }
      })
      meta[entry.alias] = {
        serverId: entry.serverId,
        serverName: entry.serverName,
        originalName: entry.originalName,
        annotations: entry.annotations,
        trust: entry.trust,
        needsApproval: needsApprovalFor(entry),
        degraded: entry.degraded,
        // Human-readable reasons; the settings UI renders them as a badge
        // tooltip ("parameters were simplified because …").
        degradationNotes: entry.degradationNotes
      }
    }

    return {
      openaiTools,
      meta,
      servers: this.getState(),
      truncated: { perServer: perServerTruncated, global: globalTruncated }
    }
  }

  /**
   * Route one external tool call. Never throws: the agent loop treats the
   * returned object as the tool result.
   * @param {string} alias
   * @param {object} args
   * @param {{timeoutMs?: number, signal?: AbortSignal, runId?: string}} [opts]
   * @returns {Promise<object>}
   */
  async callTool (alias, args, opts = {}) {
    const entry = this.registry.get(String(alias))
    if (!entry) {
      return {
        ok: false,
        error: {
          code: ERR.UNKNOWN_TOOL,
          message: `unknown external tool: ${alias}`,
          tool: String(alias),
          known: Array.from(this.registry.keys()).slice(0, 5)
        }
      }
    }
    const record = this.sessions.get(entry.serverId)
    if (!record || !['ready', 'degraded'].includes(record.session.state)) {
      return {
        ok: false,
        error: {
          code: ERR.UNAVAILABLE,
          message: `MCP server "${entry.serverName}" is not connected`,
          serverId: entry.serverId,
          hint: 'enable the server in Settings > AI > MCP servers'
        }
      }
    }
    const validation = validateArgs(entry.parameters, args === undefined ? {} : args)
    if (!validation.ok) {
      return {
        ok: false,
        error: {
          code: ERR.INVALID_ARGS,
          message: 'tool arguments do not match the declared schema',
          errors: validation.errors
        }
      }
    }
    try {
      const result = await record.session.callTool(entry.originalName, args || {}, {
        timeoutMs: opts.timeoutMs || record.config.timeoutMs,
        signal: opts.signal
      })
      return {
        ok: true,
        text: result.text,
        isError: result.isError,
        serverId: entry.serverId,
        toolName: entry.originalName
      }
    } catch (err) {
      const error = normalizeError(err)
      return { ok: false, error: error.toErrorObject() }
    }
  }

  /**
   * Close every session (app quit, tests).
   * @returns {Promise<void>}
   */
  async shutdownAll () {
    const ids = Array.from(this.sessions.keys())
    for (const id of ids) {
      await this.disconnect(id, 'shutdown')
    }
    this._refreshRegistry()
  }

  /**
   * Synchronously SIGTERM every live child. `shutdownAll()` is the correct path
   * (it awaits the real exit), but it is async and `will-quit` may never come
   * back to the event loop — this guarantees no orphan even then (M9).
   */
  killAllNow () {
    for (const record of this.sessions.values()) {
      const transport = record.session && record.session.transport
      if (transport && typeof transport.killNow === 'function') {
        transport.killNow()
      }
    }
  }

  /**
   * @param {object} config normalized server record
   * @returns {McpSession}
   * @private
   */
  _createSession (config) {
    const transport = this.transportFactory
      ? this.transportFactory(config)
      : config.transport === 'http'
        ? new HttpTransport({
          url: config.url,
          headers: config.headers,
          timeoutMs: config.timeoutMs,
          fetchImpl: this.fetchImpl,
          label: config.name
        })
        : new StdioTransport({
          command: config.command,
          args: config.args,
          cwd: config.cwd,
          env: config.env,
          spawnImpl: this.spawnImpl,
          label: config.name
        })
    const session = new McpSession({
      serverConfig: config,
      transport,
      clientInfo: this.clientInfo,
      log: this.log
    })
    // The transport must exist before the session (its constructor is cheap),
    // but only the session knows what to do with the messages.
    transport.onMessage = (msg) => session.handleMessage(msg)
    transport.onClose = (info) => session.handleTransportClosed(info)
    transport.onProtocolError = (err) => session.handleProtocolError(err)
    return session
  }

  /**
   * Re-read the tool table from every live session without tearing connections
   * down. This is what the renderer's Refresh button maps to (`force: true`):
   * a server may add tools at runtime, and nothing else re-lists them — the
   * connection signature only covers configuration, so `syncConfig` alone would
   * report "nothing changed" and the new tools would stay invisible until the
   * user restarted the server. Per-session failures keep the old table (a
   * server that is briefly unreachable must not blank the tool list).
   * @returns {Promise<void>}
   */
  async refreshTools () {
    for (const record of this.sessions.values()) {
      const { session, config } = record
      if (!session || !['ready', 'degraded'].includes(session.state)) {
        continue
      }
      try {
        await session.listTools()
        this._info(`refreshed tools for ${config.name}: ${session.tools.length}`)
      } catch (err) {
        this._warn(`tool refresh failed for ${config.name}: ${normalizeError(err).message}`)
      }
    }
    this._refreshRegistry()
  }

  /**
   * Rebuild alias → entry from every live session's tool table.
   * @private
   */
  _refreshRegistry () {
    const registry = new Map()
    for (const [serverId, record] of this.sessions) {
      const { session } = record
      if (!session || !['ready', 'degraded'].includes(session.state)) {
        continue
      }
      const tools = session.tools || []
      const byName = new Map(tools.map(tool => [tool.name, tool]))
      const aliases = buildServerAliases(serverId, tools.map(tool => tool.name))
      aliases.forEach((built, index) => {
        const tool = byName.get(built.originalName)
        if (!tool) {
          return
        }
        if (built.deduped) {
          this._warn(`duplicate tool name after sanitizing on ${record.config.name}: "${built.originalName}" → ${built.alias}`)
        }
        if (built.truncated) {
          this._warn(`tool name truncated on ${record.config.name}: "${built.originalName}" → ${built.alias}`)
        }
        const slimmed = toOpenAIParameters(tool.inputSchema, this.limits)
        if (slimmed.degraded) {
          this._warn(`schema degraded for ${built.alias}: ${slimmed.notes.join('; ') || 'complex schema'}`)
        }
        registry.set(built.alias, {
          alias: built.alias,
          serverId,
          serverName: record.config.name,
          originalName: built.originalName,
          description: tool.description,
          annotations: tool.annotations,
          trust: record.config.trust,
          parameters: slimmed.parameters,
          degraded: slimmed.degraded,
          degradationNotes: slimmed.notes.slice(),
          overPerServerLimit: index >= this.limits.perServerTools
        })
      })
    }
    this.registry = registry
  }

  /**
   * @param {string} message
   * @private
   */
  _warn (message) {
    this.warnings.push(message)
    if (this.warnings.length > 100) {
      this.warnings.shift()
    }
    this.log(`[mcp] ${message}`)
  }

  /**
   * @param {string} message
   * @private
   */
  _info (message) {
    this.log(`[mcp] ${message}`)
  }
}

let instance = null

/**
 * Process-wide manager. Created lazily so requiring this module has no side
 * effects (tests build their own instances).
 * @param {object} [opts] only used when creating the singleton
 * @returns {McpClientManager}
 */
function getManager (opts = {}) {
  if (!instance) {
    instance = new McpClientManager(opts)
  }
  return instance
}

/**
 * Drop the singleton (tests, and app shutdown in E2E runs).
 */
function resetManager () {
  instance = null
}

module.exports = {
  McpClientManager,
  getManager,
  resetManager,
  needsApprovalFor
}
