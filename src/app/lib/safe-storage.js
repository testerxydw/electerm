/**
 * Safe storage wrapper using Electron's safeStorage API.
 * Provides OS-level encryption:
 *   - macOS:   Keychain
 *   - Windows: DPAPI (Data Protection API, bound to current user account)
 *   - Linux:   libsecret / gnome-keyring (falls back to an internal key)
 *
 * Encrypted values are stored as base64 strings prefixed with SAFE_PREFIX so
 * they can be distinguished from plain-text or legacy-encrypted values.
 *
 * Storage prefix vocabulary — every persisted string must carry one of these,
 * because "not encrypted" has to be visible on disk (the db layer prefixes
 * whatever comes back with its own `enc:` marker, so a silent plaintext
 * fallback used to look exactly like an encrypted record):
 *
 *   v2:safe:<base64>   encrypted with the OS keyring
 *   v1:plain:<text>    deliberately stored as plain text, because the OS
 *                      keyring is unavailable in this environment
 *   <no prefix>        legacy values written before the v1:plain marker
 *                      existed; still readable so user data is not lost
 */

const SAFE_PREFIX = 'v2:safe:'
const PLAIN_PREFIX = 'v1:plain:'

// Module-level latches so a broken keyring does not flood the log on every
// database write: the user needs to be told once, not once per config save.
let _plainWarned = false
let _decryptErrorLogged = false

let _ss = null

function getSS () {
  if (_ss === null) {
    try {
      const { safeStorage } = require('electron')
      _ss = safeStorage
    } catch (_) {
      _ss = undefined
    }
  }
  return _ss
}

/**
 * Report, once per process, that values are being written without encryption.
 * @param {string} reason
 */
function warnPlainFallback (reason) {
  if (_plainWarned) return
  _plainWarned = true
  console.warn(
    '[safe-storage] OS keyring unavailable (' + reason + '): sensitive ' +
    'config is saved as plain text, marked with "' + PLAIN_PREFIX + '". ' +
    'Install a keyring (gnome-keyring / kwallet) to have it encrypted.'
  )
}

/**
 * Report, once per process, that a stored value could not be decrypted.
 * @param {string} reason
 */
function logDecryptError (reason) {
  if (_decryptErrorLogged) return
  _decryptErrorLogged = true
  console.error(
    '[safe-storage] cannot decrypt the stored value (' + reason + '): ' +
    'please re-enter the credential in Settings — the encrypted blob is not ' +
    'recoverable on this machine.'
  )
}

/**
 * Encrypt a string using the OS-level secure storage.
 * When encryption is not possible the value is returned with the PLAIN_PREFIX
 * marker instead of raw, so that "stored unencrypted" stays visible on disk.
 * @param {string} str
 * @returns {string}
 */
exports.safeEncrypt = function (str) {
  if (typeof str !== 'string' || !str) return str
  const ss = getSS()
  if (!ss) {
    warnPlainFallback('safeStorage is not available')
    return PLAIN_PREFIX + str
  }
  try {
    const buf = ss.encryptString(str)
    return SAFE_PREFIX + buf.toString('base64')
  } catch (e) {
    warnPlainFallback('encryptString failed: ' + ((e && e.message) || e))
    return PLAIN_PREFIX + str
  }
}

/**
 * Decrypt a string that was encrypted with safeEncrypt.
 * Values that were never encrypted (v1:plain: or legacy prefix-free plain text)
 * are returned as they are, so old user data keeps working.
 * A value that carries the encryption marker but cannot be decrypted returns an
 * empty string on purpose: handing the ciphertext to the caller would send
 * `v2:safe:AAA…` to the provider as an API key and the user would only ever see
 * an opaque 401.
 * @param {string} str
 * @returns {string}
 */
exports.safeDecrypt = function (str) {
  if (typeof str !== 'string' || !str) return str
  if (str.startsWith(PLAIN_PREFIX)) return str.slice(PLAIN_PREFIX.length)
  if (!str.startsWith(SAFE_PREFIX)) return str
  const ss = getSS()
  if (!ss) {
    logDecryptError('safeStorage is not available')
    return ''
  }
  try {
    const base64 = str.slice(SAFE_PREFIX.length)
    const buf = Buffer.from(base64, 'base64')
    return ss.decryptString(buf)
  } catch (e) {
    logDecryptError('decryptString failed: ' + ((e && e.message) || e))
    return ''
  }
}

exports.SAFE_PREFIX = SAFE_PREFIX
exports.PLAIN_PREFIX = PLAIN_PREFIX
