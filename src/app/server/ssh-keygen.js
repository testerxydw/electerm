/**
 * G7 密钥生成的落盘层：判据全在 src/app/common/ssh-keygen.js（planKeyGen），
 * 这里只做 mkdir + 生成 + 独占写。
 *
 * 「已存在则拒绝覆盖」靠 `wx` flag，而不是 exists() 先查后写——查与写之间
 * 别的进程建出同名文件时，先查后写会把那份覆盖掉。planKeyGen 里的 exists
 * 预检只是为了在典型场景下给出更早的报错（也省下几秒的 RSA 生成时间）。
 */
const fs = require('fs')
const os = require('os')
const { dirname, join, resolve } = require('path')
const { generateKeyPairSync } = require('@electerm/ssh2').utils
const { planKeyGen } = require('../common/ssh-keygen')

function getSshDir () {
  return join(os.homedir(), '.ssh')
}

function keyGenOptions (plan) {
  const opts = { comment: plan.comment }
  if (plan.bits) {
    opts.bits = plan.bits
  }
  if (plan.encrypted) {
    opts.passphrase = plan.passphrase
    opts.cipher = plan.cipher
  }
  return opts
}

function withNewline (text) {
  return String(text).endsWith('\n') ? String(text) : `${text}\n`
}

async function writeExclusive (path, content, mode) {
  try {
    await fs.promises.writeFile(path, content, { flag: 'wx', mode })
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      throw new Error(`key file already exists: ${path}`)
    }
    throw err
  }
}

/**
 * 生成并写入一对密钥。返回值刻意是白名单字段，口令不进返回值、不进日志。
 */
async function generateSshKey (options = {}) {
  const { dir = getSshDir() } = options
  const plan = planKeyGen({
    type: options.type,
    name: options.name,
    passphrase: options.passphrase,
    dir,
    exists: (p) => fs.existsSync(p)
  })
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
  const pair = generateKeyPairSync(plan.ssh2Type, keyGenOptions(plan))
  await writeExclusive(plan.privateKeyPath, withNewline(pair.private), plan.privMode)
  try {
    await writeExclusive(plan.publicKeyPath, withNewline(pair.public), plan.pubMode)
  } catch (err) {
    // 只有私钥没有公钥的半套密钥比没有密钥更糟：撤掉刚写的私钥再报错
    await fs.promises.rm(plan.privateKeyPath, { force: true })
    throw err
  }
  return {
    keyName: plan.keyName,
    keyType: plan.ssh2Type,
    bits: plan.bits,
    encrypted: plan.encrypted,
    privateKeyPath: plan.privateKeyPath,
    publicKeyPath: plan.publicKeyPath,
    publicLine: pair.public
  }
}

/**
 * 公钥是给远程机器粘贴的内容，渲染层要读它。路径不能由渲染层随便指定，
 * 这里只放行 `dir` 这一层目录里的 `.pub` 文件（不递归、不跟符号链接出去）。
 */
async function readPublicKey (options = {}) {
  const { dir = getSshDir(), publicKeyPath } = options
  const base = resolve(dir)
  const target = resolve(String(publicKeyPath || ''))
  if (dirname(target) !== base || !target.endsWith('.pub')) {
    throw new Error(`only .pub files directly under ${base} can be read back`)
  }
  const content = await fs.promises.readFile(target, 'utf8')
  return {
    publicKeyPath: target,
    publicLine: content.trimEnd()
  }
}

module.exports = {
  generateSshKey,
  getSshDir,
  keyGenOptions,
  readPublicKey,
  writeExclusive
}
