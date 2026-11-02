// runtime-constants (via ../common/log) can only load its package.json with the
// dev flag outside a packaged app -- see log-debug-level.spec.js
process.env.NODE_ENV = 'development'

const { describe, test, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const {
  KEY_TYPES,
  MIN_PASSPHRASE,
  MAX_NAME,
  resolveKeyType,
  defaultKeyName,
  assertKeyName,
  passphraseProblem,
  planKeyGen,
  generateSshKeyPair,
  expandPath,
  sshKeyDir
} = require('../../app/common/ssh-keygen')

const ssh2 = require('@electerm/ssh2')

let base

function tmpDir (name) {
  const dir = path.join(base, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function hasSshKeygen () {
  try {
    execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' })
    return true
  } catch (err) {
    // `ssh-keygen -?` exits non-zero on every platform; what matters is that it ran
    return err.code !== 'ENOENT'
  }
}

before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-ssh-keygen-'))
})

after(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

const AT = new Date(2026, 9, 30, 12, 34, 56)

describe('G7 密钥类型', () => {
  test('只认这三种，且大小写不分', () => {
    assert.deepEqual(
      Object.keys(KEY_TYPES),
      ['ed25519', 'rsa', 'ecdsa']
    )
    assert.deepEqual(resolveKeyType('ED25519'), { type: 'ed25519', ssh2Type: 'ed25519', bits: undefined })
    assert.equal(resolveKeyType('rsa').bits, 4096)
    assert.equal(resolveKeyType('ecdsa').bits, 384)
    for (const bad of ['dsa', 'ed2551', '', null, undefined, 'rsa2048']) {
      assert.throws(() => resolveKeyType(bad), /unsupported key type/, String(bad) + ' 不该被接受')
    }
  })

  test('默认名 = electerm_类型_日期，同一天同类型会撞名（由拒绝覆盖那条判据兜住）', () => {
    assert.equal(defaultKeyName('ed25519', AT), 'electerm_ed25519_20261030')
    assert.equal(defaultKeyName('RSA', AT), 'electerm_rsa_20261030')
    assert.equal(
      defaultKeyName('ecdsa', new Date(2026, 0, 1)),
      'electerm_ecdsa_20260101'
    )
  })
})

describe('G7 名字与口令校验', () => {
  test('名字只能是一个路径分量', () => {
    assert.equal(assertKeyName(' my_key '), 'my_key')
    for (const bad of [
      '', '   ', 'a/b', 'a\\b', 'a\nb', 'a\rb', '.', '..',
      'a'.repeat(MAX_NAME + 1), 'x.pub', 'X.PUB'
    ]) {
      assert.throws(() => assertKeyName(bad), /.+/, JSON.stringify(bad) + ' 不该被接受')
    }
    // 非字符串（渲染层传错类型）也走同一条拒径，不落到 regex 上抛 TypeError
    for (const bad of [null, undefined, 123, {}]) {
      assert.throws(() => assertKeyName(bad), /non-empty string/)
    }
  })

  test('空口令 = 不加密（合法），给了就要够长', () => {
    assert.equal(passphraseProblem(''), '')
    assert.equal(passphraseProblem(undefined), '')
    assert.equal(passphraseProblem(null), '')
    assert.equal(passphraseProblem('a'.repeat(MIN_PASSPHRASE)), '')
    assert.equal(passphraseProblem('a'.repeat(MIN_PASSPHRASE - 1)), 'short')
    assert.equal(passphraseProblem('a'.repeat(300)), 'long')
    assert.equal(passphraseProblem(12345678), 'type')
  })
})

describe('G7 生成计划', () => {
  test('明文 ed25519：路径、权限位、comment 与不加密', () => {
    const p = planKeyGen({ dir: '/home/u/.ssh', at: AT })
    assert.equal(p.privateKeyPath, '/home/u/.ssh/electerm_ed25519_20261030')
    assert.equal(p.publicKeyPath, p.privateKeyPath + '.pub')
    assert.equal(p.privMode, 0o600)
    assert.equal(p.pubMode, 0o644)
    assert.equal(p.encrypted, false)
    assert.equal(p.cipher, undefined)
    assert.equal(p.passphrase, undefined)
    // comment 用文件名：公钥行里能看出这把钥匙是谁、哪天生成的
    assert.equal(p.comment, 'electerm_ed25519_20261030')
    assert.equal(p.ssh2Type, 'ed25519')
  })

  test('带口令 → 走 ssh2 认得的 aes256-cbc，且口令原样交给库', () => {
    const p = planKeyGen({ dir: '/k', name: 'n1', passphrase: 'long-enough', at: AT })
    assert.equal(p.encrypted, true)
    assert.equal(p.cipher, 'aes256-cbc')
    assert.equal(p.passphrase, 'long-enough')
  })

  test('太短的口令在这里就拒，不落盘也不生成', () => {
    assert.throws(() => planKeyGen({ dir: '/k', passphrase: 'abc' }), /passphrase short/)
    assert.throws(() => planKeyGen({ dir: '/k', passphrase: 123 }), /passphrase type/)
  })

  test('已存在就拒绝覆盖（私钥或公钥任一存在都不行）', () => {
    const existsPriv = (f) => f.endsWith('electerm_ed25519_20261030')
    assert.throws(
      () => planKeyGen({ dir: '/k', at: AT, exists: existsPriv }),
      /already exists: \/k\/electerm_ed25519_20261030$/
    )
    const existsPub = (f) => f.endsWith('.pub')
    assert.throws(
      () => planKeyGen({ dir: '/k', at: AT, exists: existsPub }),
      /already exists: .*\.pub$/
    )
  })

  test('没有目录就不拼路径（拼出来会是相对路径，写进 cwd）', () => {
    for (const dir of [undefined, null, '', 0]) {
      assert.throws(() => planKeyGen({ dir, at: AT }), /non-empty path/, String(dir))
    }
  })

  test('坏类型 / 坏名字在算路径之前就被拒', () => {
    assert.throws(() => planKeyGen({ dir: '/k', type: 'dsa', at: AT }), /unsupported key type/)
    assert.throws(() => planKeyGen({ dir: '/k', name: '../escape', at: AT }), /path separator/)
  })
})

describe('G7 计划真能喂给 ssh2（库在我手里，判据不该只停在字符串形状）', () => {
  test('ed25519 按 plan 生成，公钥行是 OpenSSH 三字段且能读回同一把钥匙', () => {
    const { utils } = require('@electerm/ssh2')
    const { parseKey } = require('@electerm/ssh2/lib/protocol/keyParser.js')
    const plan = planKeyGen({ dir: '/k', at: AT })
    const r = utils.generateKeyPairSync(plan.ssh2Type, {
      comment: plan.comment,
      cipher: plan.cipher,
      passphrase: plan.passphrase
    })
    const fields = r.public.split(' ')
    assert.equal(fields.length, 3, '公钥行 = 算法 + base64 + comment')
    assert.equal(fields[0], 'ssh-ed25519')
    assert.equal(fields[2], plan.comment)
    assert.ok(r.private.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----'), '要原生 OpenSSH 格式，不是 PKCS8')
    const back = parseKey(r.private)
    assert.ok(!(back instanceof Error), back && back.message)
    assert.equal(back.type, 'ssh-ed25519')
    assert.equal(back.getPublicSSH().toString('base64'), fields[1])
  })

  test('带口令时：错口令读不回，对口令读回同一把公钥', () => {
    const { utils } = require('@electerm/ssh2')
    const { parseKey } = require('@electerm/ssh2/lib/protocol/keyParser.js')
    const plan = planKeyGen({ dir: '/k', name: 'enc', passphrase: 'long-enough', at: AT })
    const r = utils.generateKeyPairSync(plan.ssh2Type, {
      comment: plan.comment,
      cipher: plan.cipher,
      passphrase: plan.passphrase
    })
    assert.ok(r.private.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----'))
    const wrong = parseKey(r.private, 'wrong-passphrase')
    assert.ok(wrong instanceof Error, '错口令必须读不出私钥')
    const right = parseKey(r.private, plan.passphrase)
    assert.ok(!(right instanceof Error), right && right.message)
    assert.equal(right.getPublicSSH().toString('base64'), r.public.split(' ')[1])
  })
})

describe('ssh-keygen expandPath', () => {
  it('expands ~ and ~/... to the home directory', () => {
    assert.equal(expandPath('~'), os.homedir())
    assert.equal(expandPath('~/.ssh'), path.join(os.homedir(), '.ssh'))
  })

  it('resolves a plain path and falls back to the ssh key dir when empty', () => {
    assert.equal(expandPath('/tmp/x'), path.resolve('/tmp/x'))
    assert.equal(expandPath(''), sshKeyDir())
  })
})

describe('ssh-keygen generateSshKeyPair', () => {
  it('writes an OpenSSH ed25519 pair into the requested dir', async () => {
    const dir = tmpDir('ed25519')
    const res = await generateSshKeyPair({
      type: 'ed25519',
      dir,
      fileName: 'id_ed25519',
      comment: 'me@example.com'
    })
    assert.equal(res.privateKeyPath, path.join(dir, 'id_ed25519'))
    assert.equal(res.publicKeyPath, path.join(dir, 'id_ed25519.pub'))
    assert.equal(res.type, 'ed25519')
    assert.equal(res.passphraseProtected, false)

    const priv = fs.readFileSync(res.privateKeyPath, 'utf8')
    const pub = fs.readFileSync(res.publicKeyPath, 'utf8')
    assert.match(priv, /^-----BEGIN OPENSSH PRIVATE KEY-----\n/)
    assert.match(pub, /^ssh-ed25519 AAAA/)
    assert.match(pub, /me@example\.com$/)
    assert.equal(res.publicKey, pub.trim())
    // the content the form copies must be exactly what landed on disk
    assert.equal(res.privateKey, priv)

    // the returned key must be readable by the same parser the session uses
    const parsed = ssh2.utils.parseKey(priv)
    assert.ok(!(parsed instanceof Error), parsed && parsed.message)
    assert.equal(parsed.type, 'ssh-ed25519')
  })

  it('makes the private key 0600 and the public key readable', { skip: process.platform === 'win32' }, async () => {
    const dir = tmpDir('mode')
    const res = await generateSshKeyPair({ dir, fileName: 'id_mode' })
    assert.equal(fs.statSync(res.privateKeyPath).mode & 0o777, 0o600)
    assert.equal(fs.statSync(res.publicKeyPath).mode & 0o777, 0o644)
  })

  it('never overwrites an existing key', async () => {
    const dir = tmpDir('no-overwrite')
    const first = await generateSshKeyPair({ dir, fileName: 'id_x' })
    const second = await generateSshKeyPair({ dir, fileName: 'id_x' })
    assert.equal(first.privateKeyPath, path.join(dir, 'id_x'))
    assert.equal(second.privateKeyPath, path.join(dir, 'id_x_1'))
    // the first key must still be the first key
    assert.notEqual(
      fs.readFileSync(first.privateKeyPath, 'utf8'),
      fs.readFileSync(second.privateKeyPath, 'utf8')
    )
  })

  it('keeps a file name from escaping the target dir', async () => {
    const dir = tmpDir('traversal')
    const res = await generateSshKeyPair({ dir, fileName: '../../evil' })
    assert.equal(path.dirname(res.privateKeyPath), dir)
    assert.equal(path.basename(res.privateKeyPath), 'evil')
  })

  it('falls back to the default name and type for junk input', async () => {
    const dir = tmpDir('junk')
    const res = await generateSshKeyPair({ dir, fileName: '   ', type: 'nope' })
    assert.equal(res.type, 'ed25519')
    assert.equal(path.basename(res.privateKeyPath), 'id_ed25519')
  })

  it('generates rsa and ecdsa keys of the requested size', async () => {
    const dir = tmpDir('sizes')
    const rsa = await generateSshKeyPair({ type: 'rsa', bits: 2048, dir, fileName: 'id_rsa' })
    assert.match(rsa.publicKey, /^ssh-rsa /)
    const ecdsa = await generateSshKeyPair({ type: 'ecdsa', bits: 384, dir, fileName: 'id_ecdsa' })
    assert.match(ecdsa.publicKey, /^ecdsa-sha2-nistp384 /)
  })

  it('encrypts the private key when a passphrase is given', async () => {
    const dir = tmpDir('passphrase')
    const res = await generateSshKeyPair({
      dir,
      fileName: 'id_pass',
      passphrase: 'secret'
    })
    assert.equal(res.passphraseProtected, true)
    const priv = fs.readFileSync(res.privateKeyPath, 'utf8')
    assert.equal(ssh2.utils.parseKey(priv).message, 'Encrypted private OpenSSH key detected, but no passphrase given')
    const parsed = ssh2.utils.parseKey(priv, 'secret')
    assert.ok(!(parsed instanceof Error), parsed && parsed.message)
    assert.equal(parsed.type, 'ssh-ed25519')
  })

  it('produces a key real ssh-keygen accepts', { skip: !hasSshKeygen() }, async () => {
    const dir = tmpDir('real-ssh-keygen')
    const res = await generateSshKeyPair({ dir, fileName: 'id_real' })
    const derived = execFileSync('ssh-keygen', ['-y', '-f', res.privateKeyPath])
      .toString()
      .trim()
      .split(' ')[1]
    assert.equal(derived, res.publicKey.split(' ')[1])
  })
})
