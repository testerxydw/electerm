/**
 * G7 密钥生成的判据层：把「类型 / 名字 / 口令」收敛成一份能直接喂给 ssh2 keygen
 * 的计划，不碰磁盘——落盘在 src/app/server/ssh-keygen.js。
 *
 * 为什么用 `@electerm/ssh2` 自带的 keygen 而不是 `crypto.generateKeyPairSync`
 * 自拼 OpenSSH 格式：ssh2 已经在依赖里（连接侧就用它），产出的是原生
 * `-----BEGIN OPENSSH PRIVATE KEY-----`（bcrypt KDF + 可选 aes256-cbc），
 * 公钥行也是它拼好的 wire blob。自拼等于把同一份 wire 编码再实现一遍，
 * 改一处要记得改两处。实测三种类型的公钥行与本机 `ssh-keygen -y -f` 逐字一致。
 *
 * 文件下半部分是上游的 generateSshKeyPair（#4554 在 ssh 表单里直接建钥），
 * 由 src/app/lib/fs.js 的 IPC 调用、落盘在同一进程；两套判据互不调用，
 * 只是同居一文件，上游数组 KEY_TYPES 在这里改叫 GEN_KEY_TYPES 让位给本地的对象表。
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

/* ------------------------------------------------------------------ *
 * 以下为上游 #4554：ssh 表单内直接建钥（fs.js IPC），跑在 server 子进程 ——
 * 之后连接时读 `privateKeyPath` 的同一个进程，桌面版落在本机磁盘，
 * web 版落在宿主机上，正是会话会去找密钥的地方。
 * ------------------------------------------------------------------ */

const fss = require('fs/promises')
const os = require('os')
const path = require('path')
const log = require('./log')

// what `ssh-keygen -N` uses for the new OpenSSH format
const DEFAULT_CIPHER = 'aes256-ctr'
const GEN_KEY_TYPES = ['ed25519', 'rsa', 'ecdsa']
const BITS = {
  rsa: [2048, 3072, 4096],
  ecdsa: [256, 384, 521]
}
const DEFAULT_NAME = {
  ed25519: 'id_ed25519',
  rsa: 'id_rsa',
  ecdsa: 'id_ecdsa'
}
const MAX_KEYS_PER_NAME = 100

function sshKeyDir () {
  // the server child gets this from the main process; the fallback covers a
  // direct require (tests) and any other host of this module
  return process.env.sshKeysPath || path.join(os.homedir(), '.ssh')
}

/**
 * Resolve `~`, `~/.ssh` or a plain path on the machine this runs on.
 * @param {string} [p]
 * @returns {string}
 */
function expandPath (p) {
  const s = String(p || '').trim()
  if (!s) {
    return sshKeyDir()
  }
  if (s === '~') {
    return os.homedir()
  }
  if (s.startsWith('~/') || s.startsWith('~\\')) {
    return path.join(os.homedir(), s.slice(2))
  }
  return path.resolve(s)
}

// a file name only: no directory part, no separators, nothing that escapes `dir`
function toFileName (name, type) {
  const base = String(name || '')
    .trim()
    .split(/[\\/]/)
    .pop()
    .replace(/[\0<>:"|?*]/g, '')
    .trim()
  if (!base || base === '.' || base === '..') {
    return DEFAULT_NAME[type]
  }
  return base
}

async function exists (p) {
  try {
    await fss.access(p)
    return true
  } catch (err) {
    return false
  }
}

/**
 * Never overwrite: the files in ~/.ssh are the user's own keys, so an existing
 * `id_ed25519` becomes `id_ed25519_1` instead of being clobbered.
 */
async function uniquePath (dir, fileName) {
  const first = path.join(dir, fileName)
  if (!await exists(first)) {
    return first
  }
  for (let i = 1; i <= MAX_KEYS_PER_NAME; i++) {
    const p = path.join(dir, `${fileName}_${i}`)
    if (!await exists(p)) {
      return p
    }
  }
  throw new Error(`too many keys named ${fileName} in ${dir}`)
}

function generateKeyPair (type, opts) {
  // required lazily: ssh2 is heavy and only needed on this one click
  const { utils } = require('@electerm/ssh2')
  return new Promise((resolve, reject) => {
    utils.generateKeyPair(type, opts, (err, keys) => {
      if (err) {
        return reject(err)
      }
      resolve(keys)
    })
  })
}

/**
 * @param {object} [opts]
 * @param {string} [opts.type] ed25519|rsa|ecdsa, default ed25519
 * @param {number} [opts.bits] rsa: 2048|3072|4096, ecdsa: 256|384|521
 * @param {string} [opts.dir] directory, `~/.ssh` when empty
 * @param {string} [opts.fileName] private key file name
 * @param {string} [opts.passphrase] encrypt the private key with it when set
 * @param {string} [opts.comment] public key comment
 * @returns {Promise<object>} { privateKeyPath, publicKeyPath, privateKey, publicKey, dir, type, passphraseProtected }
 */
async function generateSshKeyPair (opts = {}) {
  const type = GEN_KEY_TYPES.includes(opts.type) ? opts.type : 'ed25519'
  const dir = expandPath(opts.dir)
  const fileName = toFileName(opts.fileName, type)
  const comment = String(opts.comment || '').trim().slice(0, 200)
  const passphrase = typeof opts.passphrase === 'string' ? opts.passphrase : ''
  const genOpts = { comment }
  if (BITS[type]) {
    const bits = parseInt(opts.bits, 10)
    genOpts.bits = BITS[type].includes(bits) ? bits : BITS[type][0]
  }
  if (passphrase) {
    // ssh2 refuses a passphrase without a cipher; this is the one ssh-keygen uses
    genOpts.passphrase = passphrase
    genOpts.cipher = DEFAULT_CIPHER
  }
  await fss.mkdir(dir, { recursive: true, mode: 0o700 })
  const privateKeyPath = await uniquePath(dir, fileName)
  const publicKeyPath = privateKeyPath + '.pub'
  const keys = await generateKeyPair(type, genOpts)
  try {
    // 0600: ssh refuses a private key that anyone else can read
    await fss.writeFile(privateKeyPath, keys.private, { mode: 0o600 })
    await fss.chmod(privateKeyPath, 0o600)
    await fss.writeFile(publicKeyPath, keys.public, { mode: 0o644 })
  } catch (err) {
    await fss.unlink(privateKeyPath).catch(() => {})
    await fss.unlink(publicKeyPath).catch(() => {})
    throw err
  }
  log.info('ssh key generated', privateKeyPath)
  return {
    privateKeyPath,
    publicKeyPath,
    // returned so the form can offer "copy private key" without a second read;
    // the same bytes that were just written to privateKeyPath
    privateKey: keys.private,
    publicKey: keys.public.trim(),
    dir,
    type,
    passphraseProtected: !!passphrase
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
  planKeyGen,
  generateSshKeyPair,
  sshKeyDir,
  expandPath
}
