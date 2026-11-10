/**
 * MCP client — JSON Schema → OpenAI `parameters` slimming, plus a loose
 * argument validator.
 *
 * External servers ship arbitrary JSON Schema; providers charge for every token
 * of it and some of them reject the request outright when the schema is huge.
 * `toOpenAIParameters()` therefore keeps a whitelisted subset and degrades
 * (never throws) when a schema is too deep, too wide, or too big.
 *
 * `validateArgs()` is a *readability* layer, not a security boundary: it rejects
 * the three mistakes models actually make (missing `required`, wrong `type`,
 * value outside `enum`) before a network round trip, and leaves unknown keys
 * alone because most servers do not declare `additionalProperties: false`. The
 * server stays the authority.
 */

const LIMITS = {
  depth: 6,
  propsPerLevel: 40,
  descChars: 1024,
  jsonBytes: 8192,
  perServerTools: 50,
  globalTools: 100
}

const DEGRADE_NOTE = '(nested)'
const UNAVAILABLE_NOTE = '(schema unavailable)'
const MAX_REF_HOPS = 3
const MAX_ENUM = 200
const MAX_COMPOSITION = 8

const SCALAR_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']

/**
 * Cut a description down to the provider budget.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function truncateDesc (text, max) {
  const s = String(text)
  if (s.length <= max) {
    return s
  }
  return s.slice(0, max - 1) + '…'
}

/**
 * Keep only the types we are willing to forward.
 * @param {*} type
 * @returns {string|string[]|undefined}
 */
function normalizeType (type) {
  if (typeof type === 'string') {
    return SCALAR_TYPES.includes(type) ? type : undefined
  }
  if (Array.isArray(type)) {
    const kept = type.filter(t => typeof t === 'string' && SCALAR_TYPES.includes(t))
    return kept.length ? kept : undefined
  }
  return undefined
}

/**
 * Collect `$defs` / `definitions` so local `$ref`s can be resolved without
 * pulling in a JSON Schema library.
 * @param {object} root
 * @returns {object}
 */
function collectDefs (root) {
  const defs = {}
  if (root && typeof root === 'object') {
    for (const key of ['$defs', 'definitions']) {
      const bag = root[key]
      if (bag && typeof bag === 'object' && !Array.isArray(bag)) {
        Object.assign(defs, bag)
      }
    }
  }
  return defs
}

/**
 * Follow up to MAX_REF_HOPS local `$ref`s. Anything else (remote refs, cycles,
 * dangling pointers) returns null and the caller degrades that node.
 * @param {object} node
 * @param {{defs: object}} ctx
 * @returns {object|null}
 */
function deref (node, ctx) {
  let current = node
  let hops = 0
  while (current && typeof current === 'object' && typeof current.$ref === 'string') {
    if (hops >= MAX_REF_HOPS) {
      return null
    }
    const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(current.$ref)
    if (!match) {
      return null
    }
    let key = match[1]
    try {
      key = decodeURIComponent(key)
    } catch (_) {
      // keep the raw key; a malformed escape is still a legitimate def name
    }
    const target = ctx.defs[key]
    if (!target || typeof target !== 'object') {
      return null
    }
    current = target
    hops++
  }
  return current && typeof current === 'object' && !Array.isArray(current) ? current : null
}

/**
 * Record why a schema had to be degraded. The notes are shown in the settings
 * UI ("this tool's parameters were simplified"), so they must name the reason
 * instead of just flagging the tool.
 * @param {Array<string>} notes
 * @param {string} note
 */
function addNote (notes, note) {
  if (!notes.includes(note)) {
    notes.push(note)
  }
}

/**
 * Slim one schema node.
 * @param {*} input
 * @param {{defs: object, limits: object, degraded: boolean, notes: Array}} ctx
 * @param {number} depth
 * @returns {object}
 */
function slimNode (input, ctx, depth) {
  if (depth > ctx.limits.depth) {
    ctx.degraded = true
    addNote(ctx.notes, `depth limit ${ctx.limits.depth} reached: nested objects collapsed`)
    return { type: 'object', description: DEGRADE_NOTE }
  }
  const node = deref(input, ctx)
  if (!node) {
    ctx.degraded = true
    addNote(ctx.notes, 'unresolvable $ref collapsed to an empty object')
    return { type: 'object', description: UNAVAILABLE_NOTE }
  }

  const out = {}
  const type = normalizeType(node.type)
  if (type) {
    out.type = type
  }
  if (typeof node.description === 'string' && node.description) {
    out.description = truncateDesc(node.description, ctx.limits.descChars)
  }
  if (typeof node.format === 'string') {
    out.format = node.format
  }
  if (node.default !== undefined) {
    out.default = node.default
  }
  if (Array.isArray(node.enum) && node.enum.length) {
    out.enum = node.enum.slice(0, MAX_ENUM)
  }
  if (typeof node.additionalProperties === 'boolean') {
    out.additionalProperties = node.additionalProperties
  } else if (node.additionalProperties && typeof node.additionalProperties === 'object') {
    out.additionalProperties = slimNode(node.additionalProperties, ctx, depth + 1)
  }

  for (const key of ['oneOf', 'anyOf']) {
    if (Array.isArray(node[key]) && node[key].length) {
      out[key] = node[key]
        .slice(0, MAX_COMPOSITION)
        .map(item => slimNode(item, ctx, depth + 1))
    }
  }

  const props = node.properties
  if (props && typeof props === 'object' && !Array.isArray(props)) {
    const required = Array.isArray(node.required)
      ? node.required.filter(key => typeof key === 'string')
      : []
    const requiredSet = new Set(required)
    const allNames = Object.keys(props)
    let names = allNames
    if (allNames.length > ctx.limits.propsPerLevel) {
      const requiredFirst = allNames.filter(name => requiredSet.has(name))
      const rest = allNames.filter(name => !requiredSet.has(name))
      names = requiredFirst.concat(rest).slice(0, ctx.limits.propsPerLevel)
      const omitted = allNames.length - names.length
      ctx.degraded = true
      addNote(ctx.notes, `${omitted} properties omitted (limit ${ctx.limits.propsPerLevel} per level)`)
      out.description = (out.description ? out.description + ' ' : '') +
        `(另有 ${omitted} 个字段已省略)`
    }
    out.type = out.type || 'object'
    out.properties = {}
    for (const name of names) {
      out.properties[name] = slimNode(props[name], ctx, depth + 1)
    }
    const keptRequired = required.filter(name => names.includes(name))
    if (keptRequired.length) {
      out.required = keptRequired
    }
  } else if (!type || type === 'object') {
    // The root of an MCP inputSchema is always an object; providers refuse a
    // parameters object without `properties`, so never emit a bare {type}.
    out.type = 'object'
    out.properties = out.properties || {}
  }

  if (node.items !== undefined) {
    out.items = Array.isArray(node.items)
      ? node.items.slice(0, MAX_COMPOSITION).map(item => slimNode(item, ctx, depth + 1))
      : slimNode(node.items, ctx, depth + 1)
  }

  return out
}

/**
 * Guarantee the top level is an object schema (what OpenAI-compatible providers
 * expect for `parameters`).
 * @param {object} params
 * @param {string} fallbackDescription
 * @param {{degraded: boolean}} ctx
 * @returns {object}
 */
function ensureRootObject (params, fallbackDescription, ctx) {
  if (params && typeof params === 'object' && params.type === 'object' &&
    params.properties && typeof params.properties === 'object') {
    return params
  }
  ctx.degraded = true
  addNote(ctx.notes, 'root is not an object schema: parameters reset to an empty object')
  const out = { type: 'object', properties: {} }
  const description = (params && params.description) || fallbackDescription
  if (description) {
    out.description = description
  }
  return out
}

/**
 * Convert a server's `inputSchema` into provider-safe `parameters`.
 *
 * The last-resort branch (`properties: {}`) is deliberate, not an accident: a
 * tool whose schema cannot fit the budget is still **callable**, because the
 * model gets an unconstrained parameters object and `validateArgs()` then has
 * nothing to reject. Throwing the tool away instead would look like "the server
 * connected but this tool never works", which is unreportable from inside the
 * settings UI — so we degrade loudly (`degraded: true` + `notes`, surfaced as a
 * badge) and keep the call path alive.
 *
 * @param {object} inputSchema
 * @param {object} [limits]
 * @returns {{parameters: object, degraded: boolean, notes: string[]}}
 */
function toOpenAIParameters (inputSchema, limits = LIMITS) {
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    return {
      parameters: { type: 'object', properties: {} },
      degraded: true,
      notes: ['inputSchema missing or not an object']
    }
  }
  const rootDescription = typeof inputSchema.description === 'string'
    ? truncateDesc(inputSchema.description, limits.descChars)
    : ''
  const defs = collectDefs(inputSchema)
  // Progressive tightening: a schema that is merely "wide" gets one more chance
  // at 4/3/2 properties per level before we throw the parameters away.
  const candidates = [
    limits,
    { ...limits, propsPerLevel: 4, depth: 3 },
    { ...limits, propsPerLevel: 3, depth: 2 },
    { ...limits, propsPerLevel: 2, depth: 2 }
  ]
  const attempts = []
  for (const candidate of candidates) {
    const notes = []
    const ctx = { defs, limits: candidate, degraded: false, notes }
    const slimmed = ensureRootObject(
      slimNode(inputSchema, ctx, 0),
      rootDescription,
      ctx
    )
    const bytes = Buffer.byteLength(JSON.stringify(slimmed), 'utf8')
    if (bytes <= limits.jsonBytes) {
      return { parameters: slimmed, degraded: ctx.degraded, notes }
    }
    attempts.push(`schema still ${bytes} bytes at propsPerLevel=${candidate.propsPerLevel}`)
  }
  return {
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: true,
      description: (rootDescription ? rootDescription + ' ' : '') +
        '(parameters omitted: schema too large)'
    },
    degraded: true,
    notes: attempts.concat(`schema too large for the ${limits.jsonBytes}-byte budget: parameters omitted, all arguments accepted`)
  }
}

/**
 * Describe one mismatch in provider-neutral JSON Schema terms.
 * @param {string} path
 * @param {string} message
 * @returns {{path: string, message: string}}
 */
function errorAt (path, message) {
  return { path, message }
}

/**
 * Loose type check. `integer` accepts integral numbers, and a `number` union
 * containing `integer` accepts both.
 * @param {object} schema
 * @param {*} value
 * @param {string} path
 * @param {Array} errors
 * @param {number} depth
 */
function validateNode (schema, value, path, errors, depth) {
  if (!schema || typeof schema !== 'object' || depth > 12) {
    return
  }
  const types = typeof schema.type === 'string'
    ? [schema.type]
    : Array.isArray(schema.type) ? schema.type : null
  if (types && value !== undefined) {
    const ok = types.some((type) => {
      switch (type) {
        case 'null': return value === null
        case 'array': return Array.isArray(value)
        case 'object': return !!value && typeof value === 'object' && !Array.isArray(value)
        case 'string': return typeof value === 'string'
        case 'integer': return typeof value === 'number' && Number.isInteger(value)
        case 'number': return typeof value === 'number' && !Number.isNaN(value)
        case 'boolean': return typeof value === 'boolean'
        default: return true
      }
    })
    if (!ok) {
      errors.push(errorAt(path, `expected ${types.join('|')}, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`))
      return
    }
  }
  if (Array.isArray(schema.enum) && schema.enum.length && value !== undefined) {
    const hit = schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))
    if (!hit) {
      errors.push(errorAt(path, `value must be one of ${schema.enum.slice(0, 10).map(item => JSON.stringify(item)).join(', ')}`))
    }
  }
  if (Array.isArray(value)) {
    if (schema.items && typeof schema.items === 'object') {
      value.forEach((item, index) => {
        validateNode(schema.items, item, `${path}[${index}]`, errors, depth + 1)
      })
    }
    return
  }
  if (value && typeof value === 'object') {
    const props = schema.properties && typeof schema.properties === 'object'
      ? schema.properties
      : {}
    const required = Array.isArray(schema.required) ? schema.required : []
    for (const key of required) {
      if (value[key] === undefined) {
        errors.push(errorAt(`${path}.${key}`, 'required field is missing'))
      }
    }
    for (const key of Object.keys(props)) {
      if (value[key] !== undefined) {
        validateNode(props[key], value[key], `${path}.${key}`, errors, depth + 1)
      }
    }
  }
}

/**
 * Validate call arguments against a (slimmed) parameters schema.
 *
 * Only **declared** keys are checked (`type`, `required`, `enum`, `items`).
 * Undeclared keys are always accepted: servers routinely accept extra fields,
 * `additionalProperties` is usually unset, and a false rejection here reads as
 * "the tool is connected but every call fails" — the worst possible failure
 * mode to debug. The server stays the authority on its own arguments.
 *
 * @param {object} parameters
 * @param {*} args
 * @returns {{ok: boolean, errors: Array<{path: string, message: string}>}}
 */
function validateArgs (parameters, args) {
  const errors = []
  if (parameters && typeof parameters === 'object') {
    validateNode(parameters, args === undefined ? {} : args, '$', errors, 0)
  }
  return errors.length ? { ok: false, errors } : { ok: true, errors: [] }
}

module.exports = {
  LIMITS,
  ALLOWED_SCALAR_TYPES: SCALAR_TYPES,
  toOpenAIParameters,
  validateArgs
}
