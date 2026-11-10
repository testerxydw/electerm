/**
 * MCP client — external tool aliasing.
 *
 * Every external tool is registered under `mcp__<serverId>__<shortName>`. The
 * prefix is the only thing that separates "a tool the model wrote itself" from
 * "a third party's tool", so the renderer can route on `startsWith('mcp__')`
 * without holding the reverse map (see design §2.5).
 *
 * The reverse map (alias → {serverId, originalName}) lives in the main process
 * only, because truncation and collision suffixes make an alias unparseable.
 */

const PREFIX = 'mcp__'
const SEP = '__'
// Provider tool-name limits are 64 characters; the 36 built-in tools max out at
// 26 (`get_background_task_status`), so 64 keeps us well clear.
const MAX_ALIAS_LENGTH = 64
const HASH_LENGTH = 4

/**
 * Reduce one name segment to `[A-Za-z0-9_-]`.
 * Consecutive `_` are deliberately *not* collapsed: collapsing would merge two
 * genuinely different tools into one alias.
 * @param {string} name
 * @returns {string}
 */
function sanitizeSegment (name) {
  const out = String(name === undefined || name === null ? '' : name)
    .replace(/[^A-Za-z0-9_-]/g, '_')
  return out || 'tool'
}

/**
 * Deterministic 32-bit FNV-1a hash in base36, used to keep truncated aliases
 * distinct. Deterministic on purpose: the same tool must get the same alias in
 * every process, otherwise the registry and the model disagree after a restart.
 * @param {string} str
 * @param {number} [len]
 * @returns {string}
 */
function shortHash (str, len = HASH_LENGTH) {
  const s = String(str === undefined || str === null ? '' : str)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36).padStart(len, '0').slice(-len)
}

/**
 * Build the alias for one tool.
 * @param {string} serverId
 * @param {string} toolName original tool name as the server reports it
 * @returns {{alias: string, shortName: string, truncated: boolean}}
 */
function buildAlias (serverId, toolName) {
  const prefix = PREFIX + sanitizeSegment(serverId) + SEP
  const budget = MAX_ALIAS_LENGTH - prefix.length
  const segment = sanitizeSegment(toolName)
  if (segment.length <= budget) {
    return {
      alias: (prefix + segment).toLowerCase(),
      shortName: segment,
      truncated: false
    }
  }
  const hash = shortHash(toolName, HASH_LENGTH)
  const keep = Math.max(1, budget - HASH_LENGTH - 1)
  const clipped = segment.slice(0, keep) + '_' + hash
  return {
    alias: (prefix + clipped).toLowerCase(),
    shortName: clipped,
    truncated: true
  }
}

/**
 * Append a collision suffix while staying inside the alias length limit.
 * @param {string} alias
 * @param {number} n
 * @returns {string}
 */
function appendSuffix (alias, n) {
  const suffix = '_' + n
  if (alias.length + suffix.length <= MAX_ALIAS_LENGTH) {
    return alias + suffix
  }
  return alias.slice(0, MAX_ALIAS_LENGTH - suffix.length) + suffix
}

/**
 * Build aliases for every tool of one server, de-duplicating within the server.
 *
 * Two different tool names can sanitize to the same segment (`a.b` and `a_b`),
 * so collisions are resolved by original-name order: the first (lexicographically)
 * keeps the plain alias, the rest get `_2`, `_3`, … — deterministic for a given
 * tool list, and every one of them is reported as `deduped` so the caller can
 * log the original-name pair.
 * @param {string} serverId
 * @param {string[]} toolNames
 * @returns {Array<{originalName: string, alias: string, shortName: string,
 *   truncated: boolean, deduped: boolean}>}
 */
function buildServerAliases (serverId, toolNames = []) {
  const entries = (Array.isArray(toolNames) ? toolNames : []).map((originalName) => {
    const built = buildAlias(serverId, originalName)
    return {
      originalName: String(originalName),
      alias: built.alias,
      shortName: built.shortName,
      truncated: built.truncated,
      deduped: false
    }
  })
  const groups = new Map()
  for (const entry of entries) {
    const list = groups.get(entry.alias)
    if (list) {
      list.push(entry)
    } else {
      groups.set(entry.alias, [entry])
    }
  }
  return entries.map((entry) => {
    const group = groups.get(entry.alias)
    if (group.length === 1) {
      return entry
    }
    const ordered = group.slice().sort((a, b) => (
      a.originalName < b.originalName ? -1 : a.originalName > b.originalName ? 1 : 0
    ))
    const index = ordered.indexOf(entry)
    if (index === 0) {
      return entry
    }
    return {
      ...entry,
      alias: appendSuffix(entry.alias, index + 1),
      deduped: true
    }
  })
}

module.exports = {
  PREFIX,
  SEP,
  MAX_ALIAS_LENGTH,
  HASH_LENGTH,
  sanitizeSegment,
  shortHash,
  buildAlias,
  buildServerAliases
}
