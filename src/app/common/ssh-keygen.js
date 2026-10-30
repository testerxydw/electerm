/**
 * G7 密钥生成的判据层：把「类型 / 名字 / 口令」收敛成一份能直接喂给 ssh2 keygen
 * 的计划，不碰磁盘——落盘在 src/app/server/ssh-keygen.js。
 *
 * 为什么用 `@electerm/ssh2` 自带的 keygen 而不是 `crypto.generateKeyPairSync`
 * 自拼 OpenSSH 格式：ssh2 已经在依赖里（连接侧就用它），产出的是原生
 * `-----BEGIN OPENSSH PRIVATE KEY-----`（bcrypt KDF + 可选 aes256-cbc），
 * 公钥行也是它拼好的 wire blob。自拼等于把同一份 wire 编码再实现一遍，
 * 改一处要记得改两处。实测三种类型的公钥行与本机 `ssh-keygen -y -f` 逐字一致。
 */
const { join } = require('path')

const KEY_TYPES = {
  ed25519: { ssh2Type: 'ed25519' },
  rsa: { ssh2Type: 'rsa', bits: 4096 },
  ecdsa: { ssh2Type: 'ecdsa', bits: 384 }
}

// 口令可选，但给了就得像个口令：1 个字符的加密私钥和明文差不多
const MIN_PASSPHRASE = 8
const MAX_PASSPHRASE = 256
const MAX_NAME = 64

const pad = (n) => String(n).padStart(2, '0')

const dateTag = (d = new Date()) => {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

function resolveKeyType (type) {
  const t = typeof type === 'string' ? type.toLowerCase() : ''
  const spec = KEY_TYPES[t]
  if (!spec) {
    throw new Error(`unsupported key type: ${type}`)
  }
  return { type: t, ssh2Type: spec.ssh2Type, bits: spec.bits }
}

function defaultKeyName (type, at) {
  return `electerm_${resolveKeyType(type).type}_${dateTag(at)}`
}

/**
 * 名字只能是一个路径分量：`a/b` 会写到别的目录里去，`.pub` 结尾会让
 * 私钥叫 `x.pub`、公钥叫 `x.pub.pub`。
 */
function assertKeyName (name) {
  const s = typeof name === 'string' ? name.trim() : ''
  if (!s) {
    throw new Error('key name must be a non-empty string')
  }
  if (s.length > MAX_NAME) {
    throw new Error(`key name must be at most ${MAX_NAME} characters`)
  }
  if (/[/\\\r\n]/.test(s)) {
    throw new Error('key name must not contain a path separator or newline')
  }
  if (s === '.' || s === '..') {
    throw new Error('key name must not be a dot entry')
  }
  if (/\.pub$/i.test(s)) {
    throw new Error('key name must not end with .pub')
  }
  return s
}

/**
 * 口令问题码。空 = 不加密（合法），其余由调用方翻成词条。
 */
function passphraseProblem (passphrase) {
  if (passphrase === undefined || passphrase === null || passphrase === '') {
    return ''
  }
  if (typeof passphrase !== 'string') {
    return 'type'
  }
  if (passphrase.length < MIN_PASSPHRASE) {
    return 'short'
  }
  if (passphrase.length > MAX_PASSPHRASE) {
    return 'long'
  }
  return ''
}

/**
 * 生成计划。`dir` 由调用方给（主进程取 `~/.ssh`），这里只拼接与校验；
 * 权限位也在这里定，落盘侧照抄，判据不散两处。
 * `exists` 注入是为了「已存在就拒绝覆盖」能在不碰磁盘的情况下被判住。
 */
function planKeyGen ({ type = 'ed25519', name, passphrase = '', dir, at, exists = () => false } = {}) {
  const spec = resolveKeyType(type)
  const keyName = assertKeyName(name === undefined || name === null
    ? defaultKeyName(spec.type, at)
    : name)
  const problem = passphraseProblem(passphrase)
  if (problem) {
    throw new Error(`passphrase ${problem}`)
  }
  const base = typeof dir === 'string' && dir ? dir : null
  if (!base) {
    throw new Error('key directory must be a non-empty path')
  }
  const privateKeyPath = join(base, keyName)
  const publicKeyPath = privateKeyPath + '.pub'
  if (exists(privateKeyPath) || exists(publicKeyPath)) {
    throw new Error(`key file already exists: ${exists(privateKeyPath) ? privateKeyPath : publicKeyPath}`)
  }
  const encrypted = !!passphrase
  return {
    ssh2Type: spec.ssh2Type,
    bits: spec.bits,
    comment: keyName,
    keyName,
    privateKeyPath,
    publicKeyPath,
    privMode: 0o600,
    pubMode: 0o644,
    encrypted,
    // ssh2 的 keygen 只认它自己 CIPHER_INFO 里的名字，aes256-cbc 是 OpenSSH 默认能读的
    cipher: encrypted ? 'aes256-cbc' : undefined,
    passphrase: encrypted ? passphrase : undefined
  }
}

module.exports = {
  KEY_TYPES,
  MIN_PASSPHRASE,
  MAX_PASSPHRASE,
  MAX_NAME,
  resolveKeyType,
  defaultKeyName,
  assertKeyName,
  passphraseProblem,
  planKeyGen
}
