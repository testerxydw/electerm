/**
 * Contract tests for the two fail-open paths in src/app/lib/safe-storage.js.
 *
 * 1. Encryption unavailable (no OS keyring, e.g. Linux without gnome-keyring,
 *    or encryptString throwing) used to return the plaintext unchanged. The db
 *    layer then prefixes it with its own `enc:` marker, so the file on disk
 *    reads `enc:{"apiKeyAI":"sk-…"}` — plaintext wearing an encryption badge.
 *    Now it comes back as `v1:plain:<text>`: visible, greppable, countable.
 *
 * 2. Decryption failing used to return the ciphertext, which the AI layer sent
 *    as the API key -> the user only ever saw an opaque provider 401. Now it
 *    fails closed with '' and one console.error telling them to re-enter it.
 *
 * The `electron` module is injected as a fake: in a plain node process the real
 * package exports the path to the binary, not the runtime API.
 */

const { test, describe } = require('node:test')
const assert = require('assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

const REPO = path.resolve(__dirname, '../../..')
const MODULE_PATH = path.join(REPO, 'src/app/lib/safe-storage.js')

// Sentinel: `require('electron')` must throw, as it does outside Electron.
const NO_ELECTRON = Symbol('no-electron')

/**
 * Run `fn` with `require('electron')` resolving to the given stub.
 * @param {object|symbol} electronStub
 * @param {Function} fn
 * @returns {*}
 */
function withElectron (electronStub, fn) {
  const original = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      if (electronStub === NO_ELECTRON) {
        throw new Error("Cannot find module 'electron'")
      }
      return electronStub
    }
    return original.call(this, request, parent, isMain)
  }
  try {
    return fn()
  } finally {
    Module._load = original
  }
}

/**
 * Load a pristine copy of safe-storage (its caches and "warn once" latches are
 * module level) and run `fn` with the electron stub still installed — every
 * safeEncrypt/safeDecrypt call is sync, so the stub only has to live that long.
 * @param {object|symbol} electronStub
 * @param {Function} fn
 * @returns {*}
 */
function withSafeStorage (electronStub, fn) {
  return withElectron(electronStub, () => {
    delete require.cache[MODULE_PATH]
    const mod = require(MODULE_PATH)
    return fn(mod)
  })
}

/**
 * Record console.warn / console.error calls made during `fn`.
 * @param {Function} fn
 * @returns {{result: *, warns: string[], errors: string[]}}
 */
function captureConsole (fn) {
  const warns = []
  const errors = []
  const originalWarn = console.warn
  const originalError = console.error
  console.warn = (...args) => { warns.push(args.map(String).join(' ')) }
  console.error = (...args) => { errors.push(args.map(String).join(' ')) }
  try {
    const result = fn()
    return { result, warns, errors }
  } finally {
    console.warn = originalWarn
    console.error = originalError
  }
}

// safeStorage stub that remembers nothing and only moves bytes around
const identityKeys = {
  encryptString: (str) => Buffer.from(str, 'utf8'),
  decryptString: (buf) => buf.toString('utf8')
}

const PLAIN_PREFIX = 'v1:plain:'
const SAFE_PREFIX = 'v2:safe:'

describe('safeEncrypt – plaintext fallback is marked, never silent', () => {
  test('safeStorage missing -> v1:plain: + original text', () => {
    const { result, warns } = captureConsole(() =>
      withSafeStorage({ safeStorage: undefined }, (ss) => {
        const out = ss.safeEncrypt('{"apiKeyAI":"sk-secret"}')
        return { out, second: ss.safeEncrypt('{"apiKeyAI":"sk-secret"}') }
      })
    )
    assert.ok(result.out.startsWith(PLAIN_PREFIX), result.out)
    assert.equal(result.out.slice(PLAIN_PREFIX.length), '{"apiKeyAI":"sk-secret"}')
    // the second call must not warn again: one line per process, not per write
    assert.ok(result.second.startsWith(PLAIN_PREFIX))
    assert.equal(warns.length, 1, `expected 1 warn, got ${warns.length}: ${warns.join(' | ')}`)
    assert.match(warns[0], /keyring/i)
    assert.match(warns[0], /plain text/i)
  })

  test('require("electron") throwing -> v1:plain: + original text', () => {
    const { result } = captureConsole(() =>
      withSafeStorage(NO_ELECTRON, (ss) => ss.safeEncrypt('sk-secret'))
    )
    assert.equal(result, PLAIN_PREFIX + 'sk-secret')
  })

  test('encryptString throwing -> v1:plain:, and only one warn', () => {
    const stub = {
      safeStorage: {
        encryptString: () => { throw new Error('keyring locked') },
        decryptString: (buf) => buf.toString('utf8')
      }
    }
    const { result, warns } = captureConsole(() =>
      withSafeStorage(stub, (ss) => {
        const first = ss.safeEncrypt('sk-secret')
        const second = ss.safeEncrypt('sk-other')
        return { first, second }
      })
    )
    assert.equal(result.first, PLAIN_PREFIX + 'sk-secret')
    assert.equal(result.second, PLAIN_PREFIX + 'sk-other')
    assert.equal(warns.length, 1, `expected 1 warn, got ${warns.length}: ${warns.join(' | ')}`)
    assert.match(warns[0], /keyring unavailable/i)
  })

  test('working keyring -> v2:safe:, no warning', () => {
    const { result, warns } = captureConsole(() =>
      withSafeStorage({ safeStorage: identityKeys }, (ss) => ss.safeEncrypt('sk-secret'))
    )
    assert.equal(result, SAFE_PREFIX + Buffer.from('sk-secret').toString('base64'))
    assert.equal(warns.length, 0)
  })

  test('empty and non-string input is returned untouched', () => {
    withSafeStorage({ safeStorage: identityKeys }, (ss) => {
      assert.equal(ss.safeEncrypt(''), '')
      assert.equal(ss.safeEncrypt(undefined), undefined)
      assert.equal(ss.safeEncrypt(42), 42)
    })
  })
})

describe('safeDecrypt – fail closed, stay compatible', () => {
  test('v2:safe: value decrypts to the plaintext', () => {
    withSafeStorage({ safeStorage: identityKeys }, (ss) => {
      const stored = SAFE_PREFIX + Buffer.from('sk-secret').toString('base64')
      assert.equal(ss.safeDecrypt(stored), 'sk-secret')
    })
  })

  test('v1:plain: value returns the text without the marker', () => {
    withSafeStorage({ safeStorage: identityKeys }, (ss) => {
      assert.equal(ss.safeDecrypt(PLAIN_PREFIX + '{"apiKeyAI":"sk-secret"}'), '{"apiKeyAI":"sk-secret"}')
    })
  })

  test('legacy prefix-free plaintext is returned unchanged', () => {
    withSafeStorage({ safeStorage: identityKeys }, (ss) => {
      assert.equal(ss.safeDecrypt('{"apiKeyAI":"sk-secret"}'), '{"apiKeyAI":"sk-secret"}')
    })
  })

  test('decryptString throwing -> empty string, error logged once', () => {
    const stub = {
      safeStorage: {
        encryptString: identityKeys.encryptString,
        decryptString: () => { throw new Error('keyring locked') }
      }
    }
    const stored = SAFE_PREFIX + Buffer.from('sk-secret').toString('base64')
    const { result, errors } = captureConsole(() =>
      withSafeStorage(stub, (ss) => {
        const first = ss.safeDecrypt(stored)
        const second = ss.safeDecrypt(stored)
        return { first, second }
      })
    )
    assert.equal(result.first, '')
    assert.equal(result.second, '')
    assert.equal(errors.length, 1, `expected 1 error, got ${errors.length}: ${errors.join(' | ')}`)
    assert.match(errors[0], /re-enter/i)
  })

  test('safeStorage missing while the value is encrypted -> empty string', () => {
    const stored = SAFE_PREFIX + Buffer.from('sk-secret').toString('base64')
    const { result, errors } = captureConsole(() =>
      withSafeStorage({ safeStorage: undefined }, (ss) => ss.safeDecrypt(stored))
    )
    assert.equal(result, '')
    assert.equal(errors.length, 1)
  })

  test('empty and non-string input is returned untouched', () => {
    withSafeStorage({ safeStorage: identityKeys }, (ss) => {
      assert.equal(ss.safeDecrypt(''), '')
      assert.equal(ss.safeDecrypt(null), null)
      assert.equal(ss.safeDecrypt(undefined), undefined)
    })
  })
})

describe('db layer keeps the plaintext marker on the enc: path', () => {
  const dbFiles = ['src/app/lib/sqlite.js', 'src/app/lib/nedb.js'].map(
    (rel) => ({ rel, src: fs.readFileSync(path.join(REPO, rel), 'utf8') })
  )

  for (const { rel, src } of dbFiles) {
    test(`${rel} writes "enc:" + enc(value) verbatim`, () => {
      assert.match(src, /const ENC_PREFIX = 'enc:'/)
      assert.match(src, /return ENC_PREFIX \+ enc\(jsonStr\)/)
      // no trim/slice/replace on the encrypted value: a `v1:plain:` marker
      // surviving that expression is the whole point
      assert.doesNotMatch(src, /ENC_PREFIX\s*\+?\s*enc\([^)]*\)\s*\.(?:trim|slice|replace)\(/)
    })
  }

  test('a v1:plain: value round-trips through the enc: prefix', () => {
    const json = JSON.stringify({ apiKeyAI: 'sk-secret', modelAI: 'gpt-x' })
    const stored = 'enc:' + PLAIN_PREFIX + json
    assert.ok(stored.startsWith('enc:' + PLAIN_PREFIX))
    withSafeStorage({ safeStorage: undefined }, (ss) => {
      const unwrapped = stored.slice('enc:'.length)
      assert.equal(ss.safeDecrypt(unwrapped), json)
    })
  })

  test('a legacy enc:<plaintext json> value is still readable', () => {
    const json = JSON.stringify({ apiKeyAI: 'sk-secret' })
    withSafeStorage({ safeStorage: identityKeys }, (ss) => {
      assert.equal(ss.safeDecrypt(('enc:' + json).slice('enc:'.length)), json)
    })
  })
})

describe('AI request side refuses an empty credential', () => {
  const aiSrc = fs.readFileSync(path.join(REPO, 'src/app/lib/ai.js'), 'utf8')
  const formSrc = fs.readFileSync(
    path.join(REPO, 'src/client/components/ai/ai-config.jsx'),
    'utf8'
  )

  test('ai.js guards before building the client and names the fix', () => {
    assert.match(aiSrc, /AI credential unavailable: please re-enter the API key in Settings/)
    assert.match(aiSrc, /assertCredential\(apiKey, baseURL\)/)
    assert.ok(
      aiSrc.indexOf('assertCredential(apiKey, baseURL)') <
        aiSrc.indexOf("const axios = require('axios')"),
      'the guard must run before axios/the client is built'
    )
  })

  test('the config form asks for a fresh key when the stored one is gone', () => {
    assert.match(formSrc, /Credential unavailable, please re-enter the API key/)
  })
})

describe('widget instance detail exposes the API key it hides from the URL', () => {
  const src = fs.readFileSync(
    path.join(REPO, 'src/client/components/widgets/widget-instance-detail.jsx'),
    'utf8'
  )

  test('the key is shown masked and copied in full', () => {
    assert.match(src, /copy\(instance\.serverInfo\.apiKey\)/)
    assert.match(src, /label: 'API key'/)
    // masked display: first 4 + **** + last 4, never the whole string
    assert.match(src, /slice\(0, 4\)\}\*\*\*\*\$\{/)
  })
})
