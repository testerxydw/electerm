/**
 * G6 主密码 Vault 的密钥层次（设计 阶段4 §14.7）
 *
 *   主密码 --scrypt(N=2^15,r=8,p=1,salt)--> KEK(32B)
 *   随机 DEK(32B) --AES-256-GCM(KEK)--> wrappedDek   // 只有这些进 config
 *   每条凭据     --AES-256-GCM(DEK, 每条独立 iv)--> 信封
 *
 * 主密码与恢复码永不落盘，KEK/DEK 只在内存；config 里全是"包好的东西"，
 * 拿到 config 也仍需主密码才能解出 DEK。
 *
 * 三条刻意的口径：
 * - 三个用途各用自己的 AAD（dek / verify / rek）：同一条密文换不了用途，
 *   把 verifier 当 wrappedDek 塞回去解不出 DEK；
 * - verifier 是"用 KEK 封的一个固定串"，口令错在这里就判掉，不动 wrappedDek；
 * - 解锁失败返回原因而不是抛异常：调用方（IPC / 弹窗）要的是能直接说给用户的一句话。
 */
const crypto = require('crypto')

const VERSION = 1
const PREFIX = 'vlt1'
const KDF = {
  N: 32768, // 2^15
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024, // scrypt 默认 32MB 装不下 N=2^15,r=8，必须显式抬
  keylen: 32
}
const SALT_LEN = 16
const IV_LEN = 12 // GCM 推荐 96 bit
const DEK_LEN = 32
const RECOVERY_BYTES = 32 // 256 bit 熵，够单独作为一条解锁路径
const MIN_MASTER_PASS = 8
const DEFAULT_AUTO_LOCK_MIN = 15
const VERIFIER_PLAIN = 'electerm-vault-verifier-v1'
const AAD = {
  dek: Buffer.from('electerm:vault:v1:dek', 'utf8'),
  verify: Buffer.from('electerm:vault:v1:verify', 'utf8'),
  rek: Buffer.from('electerm:vault:v1:rek', 'utf8')
}
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

const FAIL = {
  wrongPassword: 'wrong-password',
  corrupt: 'corrupt',
  noVault: 'no-vault',
  weakPassword: 'weak-password',
  empty: 'empty'
}

function scrypt (secret, salt, kdf) {
  // 调用方（IPC 传进来的 config.kdf）只给部分参数时补齐，别把 undefined 塞进 crypto
  const k = { ...KDF, ...kdf }
  return new Promise((resolve, reject) => {
    crypto.scrypt(Buffer.from(String(secret), 'utf8'), salt, k.keylen, {
      N: k.N, r: k.r, p: k.p, maxmem: k.maxmem
    }, (err, key) => {
      if (err) {
        return reject(err)
      }
      resolve(key)
    })
  })
}

/** 信封：vlt1:<iv hex>:<tag hex>:<cipher hex>；明文一律按 utf8 处理 */
function seal (plain, key, aad) {
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
  if (aad) {
    cipher.setAAD(aad)
  }
  const body = Buffer.concat([
    cipher.update(Buffer.from(String(plain), 'utf8')),
    cipher.final()
  ])
  return [PREFIX, iv.toString('hex'), cipher.getAuthTag().toString('hex'), body.toString('hex')].join(':')
}

/**
 * @returns {{ok: true, value: string} | {ok: false, reason}}
 * 结构不对与认证不过要分开：前者是数据坏了（config 被截断/改过），
 * 后者在 KEK 路径上就是"口令错"。
 */
function open (envelope, key, aad) {
  const parts = typeof envelope === 'string' ? envelope.split(':') : []
  if (parts.length !== 4 || parts[0] !== PREFIX || !isHex(parts[1]) || !isHex(parts[2]) || !isHex(parts[3])) {
    return { ok: false, reason: FAIL.corrupt }
  }
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(parts[1], 'hex'),
      { authTagLength: 16 }
    )
    if (aad) {
      decipher.setAAD(aad)
    }
    decipher.setAuthTag(Buffer.from(parts[2], 'hex'))
    const value = Buffer.concat([
      decipher.update(Buffer.from(parts[3], 'hex')),
      decipher.final()
    ]).toString('utf8')
    return { ok: true, value }
  } catch (err) {
    return { ok: false, reason: authFailure(err) ? FAIL.wrongPassword : FAIL.corrupt }
  }
}

function authFailure (err) {
  const text = String((err && err.message) || err)
  return /bad decrypt|auth tag|invalid auth|Unsupported state/i.test(text)
}

function isHex (s) {
  return /^[0-9a-f]*$/i.test(String(s || '')) && String(s || '').length % 2 === 0
}

function isHexLen (s, bytes) {
  return typeof s === 'string' && s.length === bytes * 2 && isHex(s)
}

function isEnvelope (s) {
  return typeof s === 'string' && s.startsWith(PREFIX + ':')
}

/**
 * 解出来的 DEK 必须是 32 字节的 hex。Buffer.from(x,'hex') 遇到非法字符是
 * "截断"而不是报错，所以这里宁可在源头判掉：形态不对就当作数据坏了，
 * 而不是带着一把被截短的密钥继续跑。
 */
function hexToDek (value) {
  if (!isHex(value)) {
    return null
  }
  const buf = Buffer.from(value, 'hex')
  return buf.length === DEK_LEN ? buf : null
}

/** 32 字节 → RFC 4648 Base32（无填充）：52 个字符，全部是可直接敲的字母数字 */
function base32Encode (buf) {
  let bits = 0
  let acc = 0
  let out = ''
  for (const byte of buf) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(acc >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) {
    out += BASE32[(acc << (5 - bits)) & 31]
  }
  return out
}

function base32Decode (text) {
  const clean = normalizeRecoveryCode(text)
  if (!clean) {
    return null
  }
  let bits = 0
  let acc = 0
  const bytes = []
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch)
    if (idx < 0) {
      return null
    }
    acc = (acc << 5) | idx
    bits += 5
    if (bits >= 8) {
      bytes.push((acc >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  // 尾部剩下的 1~4 bit 必须全为 0，否则这不是我们发出去的那串
  if (bits >= 5 || (acc & ((1 << bits) - 1)) !== 0) {
    return null
  }
  return Buffer.from(bytes)
}

function newRecoveryCode () {
  return base32Encode(crypto.randomBytes(RECOVERY_BYTES))
}

/** 用户要抄下来：每 5 个一组，组间用空格（顺手归一大小写，展示的就是能敲回去的） */
function formatRecoveryCode (code) {
  return (normalizeRecoveryCode(code).match(/.{1,5}/g) || []).join(' ')
}

function normalizeRecoveryCode (input) {
  return String(input || '').toUpperCase().replace(/[^A-Z2-7]/g, '')
}

function isVaultConfig (config) {
  return !!config && typeof config === 'object' && config.v === VERSION &&
    isHexLen(config.salt, SALT_LEN) &&
    isEnvelope(config.wrappedDek) && isEnvelope(config.verifier) &&
    Number.isFinite(Number(config.autoLockMin)) && Number(config.autoLockMin) > 0
}

function kdfOf (config) {
  const k = (config && config.kdf) || {}
  return {
    N: Number(k.N) || KDF.N,
    r: Number(k.r) || KDF.r,
    p: Number(k.p) || KDF.p,
    maxmem: Number(k.maxmem) || KDF.maxmem,
    keylen: Number(k.keylen) || KDF.keylen
  }
}

/**
 * 建库：salt / wrappedDek / verifier 进 config，DEK 与恢复码交回调用方。
 * 恢复码可以传进来（改主密码时要保住已经抄走的那一份），不传就新生成。
 * kdf 只在建库时指定（单测要跑低成本参数）；参数会写进 config，
 * 之后 unlock / changeMasterPassword 都按 config 里的来。
 */
async function createVault (opts = {}) {
  const {
    masterPassword = '',
    autoLockMin = DEFAULT_AUTO_LOCK_MIN,
    recoveryCode = newRecoveryCode(),
    dek = crypto.randomBytes(DEK_LEN),
    kdf = KDF
  } = opts
  if (typeof masterPassword !== 'string' || masterPassword.length < MIN_MASTER_PASS) {
    return { ok: false, reason: FAIL.weakPassword }
  }
  const clean = normalizeRecoveryCode(recoveryCode)
  const codeKey = base32Decode(clean)
  if (!codeKey || codeKey.length !== RECOVERY_BYTES) {
    return { ok: false, reason: FAIL.empty }
  }
  const salt = crypto.randomBytes(SALT_LEN)
  const recoverySalt = crypto.randomBytes(SALT_LEN)
  const kek = await scrypt(masterPassword, salt, kdf)
  const rek = await scrypt(clean, recoverySalt, kdf)
  return {
    ok: true,
    dek,
    recoveryCode: clean,
    config: {
      v: VERSION,
      kdf: { N: kdf.N, r: kdf.r, p: kdf.p },
      salt: salt.toString('hex'),
      wrappedDek: seal(dek.toString('hex'), kek, AAD.dek),
      verifier: seal(VERIFIER_PLAIN, kek, AAD.verify),
      recovery: {
        salt: recoverySalt.toString('hex'),
        wrappedDek: seal(dek.toString('hex'), rek, AAD.rek)
      },
      autoLockMin
    }
  }
}

/** 口令先过 verifier，过了才去解 DEK：口令错时不碰 wrappedDek */
async function unlock (masterPassword, config) {
  if (!isVaultConfig(config)) {
    return { ok: false, reason: FAIL.noVault }
  }
  if (typeof masterPassword !== 'string' || !masterPassword) {
    return { ok: false, reason: FAIL.empty }
  }
  const kdf = kdfOf(config)
  const kek = await scrypt(masterPassword, Buffer.from(config.salt, 'hex'), kdf)
  const check = open(config.verifier, kek, AAD.verify)
  if (!check.ok) {
    // verifier 读不出明文是"口令错"，读出来但结构坏了是"库坏了"——两者别说成同一句话
    return { ok: false, reason: check.reason === FAIL.corrupt ? FAIL.corrupt : FAIL.wrongPassword }
  }
  if (check.value !== VERIFIER_PLAIN) {
    return { ok: false, reason: FAIL.corrupt }
  }
  const unwrapped = open(config.wrappedDek, kek, AAD.dek)
  if (!unwrapped.ok) {
    return { ok: false, reason: FAIL.corrupt }
  }
  const dek = hexToDek(unwrapped.value)
  if (!dek) {
    return { ok: false, reason: FAIL.corrupt }
  }
  return { ok: true, dek }
}

/**
 * 恢复码这条路自己验自己：主密码不参与，所以 verifier 在这条路上用不上
 * （verifier 是给 KEK 用的）。recovery 段缺或坏掉时只可能是 noVault，
 * 不能让它一路撞进 scrypt 抛异常。
 */
function hasRecovery (config) {
  return !!config && !!config.recovery &&
    isHexLen(config.recovery.salt, SALT_LEN) && isEnvelope(config.recovery.wrappedDek)
}

async function unlockWithRecovery (recoveryCode, config) {
  if (!isVaultConfig(config) || !hasRecovery(config)) {
    return { ok: false, reason: FAIL.noVault }
  }
  const clean = normalizeRecoveryCode(recoveryCode)
  if (!clean) {
    return { ok: false, reason: FAIL.empty }
  }
  const rek = await scrypt(clean, Buffer.from(config.recovery.salt, 'hex'), kdfOf(config))
  const unwrapped = open(config.recovery.wrappedDek, rek, AAD.rek)
  if (!unwrapped.ok) {
    return { ok: false, reason: FAIL.wrongPassword }
  }
  const dek = hexToDek(unwrapped.value)
  if (!dek) {
    return { ok: false, reason: FAIL.corrupt }
  }
  return { ok: true, dek }
}

/**
 * 换主密码：同一把 DEK 用新 KEK 重新包一份，恢复码那一份原样留着
 * （用户手里那串还能用，不必重新抄）。
 */
async function changeMasterPassword (masterPassword, config, dek) {
  if (!isVaultConfig(config)) {
    return { ok: false, reason: FAIL.noVault }
  }
  if (typeof masterPassword !== 'string' || masterPassword.length < MIN_MASTER_PASS) {
    return { ok: false, reason: FAIL.weakPassword }
  }
  if (!Buffer.isBuffer(dek) || dek.length !== DEK_LEN) {
    return { ok: false, reason: FAIL.corrupt }
  }
  const salt = crypto.randomBytes(SALT_LEN)
  const kek = await scrypt(masterPassword, salt, kdfOf(config))
  return {
    ok: true,
    config: {
      ...config,
      salt: salt.toString('hex'),
      wrappedDek: seal(dek.toString('hex'), kek, AAD.dek),
      verifier: seal(VERIFIER_PLAIN, kek, AAD.verify)
    }
  }
}

/** 逐条凭据：每条一个随机 iv，同一条明文两次加密的两个信封互不相同 */
function sealSecret (plain, dek) {
  return seal(plain, dek, null)
}

function openSecret (envelope, dek) {
  return open(envelope, dek, null)
}

/** 用完就地把密钥清零（尽力而为：Node 不保证内存里不留副本，但不留比不留强） */
function zeroKey (buf) {
  if (Buffer.isBuffer(buf)) {
    buf.fill(0)
  }
}

module.exports = {
  AAD,
  DEFAULT_AUTO_LOCK_MIN,
  FAIL,
  KDF,
  MIN_MASTER_PASS,
  PREFIX,
  VERIFIER_PLAIN,
  VERSION,
  base32Decode,
  base32Encode,
  changeMasterPassword,
  createVault,
  formatRecoveryCode,
  hasRecovery,
  isVaultConfig,
  newRecoveryCode,
  normalizeRecoveryCode,
  open,
  openSecret,
  seal,
  sealSecret,
  unlock,
  unlockWithRecovery,
  zeroKey
}
