// runtime-constants (via common/log) can only load its package.json with the
// dev flag outside a packaged app -- see log-debug-level.spec.js
process.env.NODE_ENV = 'development'

const { after, describe, test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  generateSshKey,
  readPublicKey,
  writeExclusive,
  getSshDir
} = require('../../app/server/ssh-keygen')

const {
  appendKnownHost,
  getKnownHostsPath,
  getHostKeyMeta,
  listKnownHosts,
  listKnownHostRows,
  removeKnownHostLine
} = require('../../app/server/ssh-known-hosts')

const { generateKeyPairSync } = require('@electerm/ssh2').utils
const { parseKey } = require('@electerm/ssh2/lib/protocol/keyParser.js')

// 一次性目录放 os.tmpdir()，删的时候直删，不进回收站（AGENTS.md 第 1/2 条）
const dirs = []
function tmpDir (prefix = 'electerm-g7-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(d)
  return d
}
after(() => {
  for (const d of dirs) {
    fs.rmSync(d, { recursive: true, force: true })
  }
  // 顺带回收 1 小时以上的陈旧遗留（同机可能有并行进程，别全清）
  const cutoff = Date.now() - 3600000
  for (const name of fs.readdirSync(os.tmpdir())) {
    if (!name.startsWith('electerm-g7-')) {
      continue
    }
    const p = path.join(os.tmpdir(), name)
    try {
      if (fs.statSync(p).mtimeMs < cutoff) {
        fs.rmSync(p, { recursive: true, force: true })
      }
    } catch {}
  }
})

const modeOf = p => fs.statSync(p).mode & 0o777

describe('G7 密钥落盘', () => {
  test('ed25519：两个文件都写出来，权限 600/644，公钥行三段', async () => {
    const dir = tmpDir()
    const r = await generateSshKey({ dir, type: 'ed25519', name: 'id_test' })
    assert.equal(r.privateKeyPath, path.join(dir, 'id_test'))
    assert.equal(r.publicKeyPath, path.join(dir, 'id_test.pub'))
    assert.equal(r.encrypted, false)
    assert.equal(modeOf(r.privateKeyPath), 0o600)
    assert.equal(modeOf(r.publicKeyPath), 0o644)
    const priv = fs.readFileSync(r.privateKeyPath, 'utf8')
    assert.ok(priv.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----'), '私钥不是 OpenSSH 原生格式')
    assert.ok(priv.endsWith('\n'), '私钥结尾没有换行，ssh -i 会报 Bad permissions 之类的外套话')
    assert.deepEqual(r.publicLine.split(' ').length, 3)
    assert.ok(r.publicLine.startsWith('ssh-ed25519 '))
    // 名字当 comment：贴到 authorized_keys 后认得出是哪把
    assert.ok(r.publicLine.endsWith(' id_test'))
    // .pub 文件就是这一行 + 换行
    assert.equal(fs.readFileSync(r.publicKeyPath, 'utf8'), r.publicLine + '\n')
  })

  test('目录不存在时递归建，且 .ssh 目录本身是 700', async () => {
    const dir = path.join(tmpDir(), '.ssh')
    await generateSshKey({ dir, type: 'ed25519', name: 'k' })
    assert.equal(modeOf(dir), 0o700)
  })

  test('口令：私钥加密、返回值与文件里都没有明文口令', async () => {
    const dir = tmpDir()
    const secret = 'correct horse battery'
    const r = await generateSshKey({ dir, type: 'ed25519', name: 'enc', passphrase: secret })
    assert.equal(r.encrypted, true)
    assert.ok(!JSON.stringify(r).includes(secret), '返回值里漏出口令')
    const priv = fs.readFileSync(r.privateKeyPath, 'utf8')
    assert.ok(!priv.includes(secret), '私钥文件里不该出现明文口令')
    const parsed = parseKey(priv, secret)
    assert.ok(!(parsed instanceof Error), '口令解不开：' + parsed.message)
    assert.ok(parseKey(priv, 'wrong passphrase') instanceof Error, '错口令应该报错')
  })

  test('同名拒覆盖：第二次生成报错，且原文件一个字节没变', async () => {
    const dir = tmpDir()
    const first = await generateSshKey({ dir, type: 'ed25519', name: 'same' })
    const before = fs.readFileSync(first.privateKeyPath, 'utf8')
    await assert.rejects(
      () => generateSshKey({ dir, type: 'ed25519', name: 'same' }),
      /key file already exists/
    )
    assert.equal(fs.readFileSync(first.privateKeyPath, 'utf8'), before, '拒覆盖却把私钥换了')
  })

  test('只存在 .pub 也拒（半套残留不能当空位覆盖）', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'half.pub'), 'ssh-ed25519 AAAA half\n')
    await assert.rejects(
      () => generateSshKey({ dir, type: 'ed25519', name: 'half' }),
      /key file already exists/
    )
    assert.equal(fs.existsSync(path.join(dir, 'half')), false, '预检失败却把私钥写出去了')
  })

  test('并发同名：wx 让恰好一个成功，另一个得到可读的已存在报错', async () => {
    const dir = tmpDir()
    const one = () => generateSshKey({ dir, type: 'ed25519', name: 'race' })
    const res = await Promise.allSettled([one(), one()])
    const ok = res.filter(r => r.status === 'fulfilled')
    assert.equal(ok.length, 1, JSON.stringify(res.map(r => r.reason && r.reason.message)))
    assert.match(res.find(r => r.status === 'rejected').reason.message, /key file already exists/)
    const pub = ok[0].value.publicKeyPath
    const priv = ok[0].value.privateKeyPath
    assert.ok(fs.existsSync(pub) && fs.existsSync(priv), '赢家把半套密钥留在了盘上')
  })

  test('writeExclusive：EEXIST 翻成人话，其它错误原样抛', async () => {
    const dir = tmpDir()
    const p = path.join(dir, 'x')
    await writeExclusive(p, 'a\n', 0o600)
    assert.equal(fs.readFileSync(p, 'utf8'), 'a\n')
    await assert.rejects(() => writeExclusive(p, 'b\n', 0o600), /key file already exists: .*x/)
    await assert.rejects(
      () => writeExclusive(path.join(dir, 'no-such-dir', 'y'), 'c', 0o600),
      /ENOENT/
    )
  })

  test('口令非法 / 名字带路径分量时，磁盘上什么都没发生', async () => {
    const dir = tmpDir()
    await assert.rejects(() => generateSshKey({ dir, type: 'ed25519', name: 'ok', passphrase: 'short' }))
    await assert.rejects(() => generateSshKey({ dir, type: 'ed25519', name: '../escape' }), /path separator/)
    assert.deepEqual(fs.readdirSync(dir), [], '校验不过也建了文件')
  })

  test('getSshDir = ~/.ssh（路径由主进程定，渲染层只递名字这类不含路径的分量）', () => {
    assert.equal(getSshDir(), path.join(os.homedir(), '.ssh'))
    assert.equal(getKnownHostsPath(), path.join(os.homedir(), '.ssh', 'known_hosts'))
  })
})

describe('G7 公钥回读', () => {
  test('只读 dir 这一层的 .pub，私钥与外面的文件都读不到', async () => {
    const dir = tmpDir()
    const r = await generateSshKey({ dir, type: 'ed25519', name: 'rb' })
    const back = await readPublicKey({ dir, publicKeyPath: r.publicKeyPath })
    assert.equal(back.publicLine, r.publicLine)

    await assert.rejects(
      () => readPublicKey({ dir, publicKeyPath: r.privateKeyPath }),
      /only \.pub files/,
      '渲染层拿私钥路径就能把它读走'
    )
    const outside = path.join(tmpDir(), 'secret.pub')
    fs.writeFileSync(outside, 'ssh-ed25519 AAAA 别的目录\n')
    await assert.rejects(() => readPublicKey({ dir, publicKeyPath: outside }), /only \.pub files/)
    await assert.rejects(
      () => readPublicKey({ dir, publicKeyPath: path.join(dir, 'sub', 'a.pub') }),
      /only \.pub files/
    )
  })

  test('路径里的 ./ 不影响归属判定（resolve 归一化后才比目录）', async () => {
    const dir = tmpDir()
    const r = await generateSshKey({ dir, type: 'ed25519', name: 'weird' })
    const back = await readPublicKey({
      dir,
      publicKeyPath: path.join(dir, '.', 'weird.pub')
    })
    assert.equal(back.publicLine, r.publicLine)
    assert.equal(back.publicKeyPath, r.publicKeyPath)
  })
})

describe('G7 known_hosts 列表面板', () => {
  const key = generateKeyPairSync('ed25519', { comment: 'fp' }).public
  const b64 = key.split(' ')[1]
  const b64b = generateKeyPairSync('ed25519', { comment: 'fp2' }).public.split(' ')[1]
  const sample = [
    '# 注释行',
    '',
    `example.com ssh-ed25519 ${b64}`,
    `10.0.0.8,${'10.0.0.9'} ssh-ed25519 ${b64b}`,
    '|1|c2FsdHNhbHRzYWx0c2FsdA==|aGVsbG9oZWxsb2hlbGxvaGVsbG8= ssh-rsa AAAAB3NzaC1yc2E=',
    `@revoked legacy.example.org ssh-rsa ${b64}`,
    '@cert-authority *.example.org ssh-ed25519 ' + b64,
    `broken.example.org ssh-ed25519 ${b64.slice(0, b64.length - 3)}`
  ].join('\n') + '\n'

  test('行号从 1 数（含注释与空行），注释/空行不成行', () => {
    const rows = listKnownHostRows(sample)
    assert.deepEqual(rows.map(r => r.lineNo), [3, 4, 5, 6, 7, 8])
    assert.deepEqual(rows[1].hosts, ['10.0.0.8', '10.0.0.9'])
    assert.equal(rows[0].hashed, false)
    assert.equal(rows[2].hashed, true, '|1| 开头的算哈希条目')
    assert.deepEqual(rows[2].hosts, [], '哈希条目不暴露主机名')
    assert.equal(rows[3].marker, '@revoked')
    assert.equal(rows[4].marker, '@cert-authority')
  })

  test('面板指纹与连接时提示的指纹是同一个算法出来的', () => {
    const rows = listKnownHostRows(sample)
    const expected = getHostKeyMeta(Buffer.from(b64, 'base64'))
    assert.equal(rows[0].fingerprint, 'SHA256:' + expected.sha256)
    // 这一步不是走形式：列表面板拿 base64 反推字节，连接时拿协议给的 Buffer，
    // 两边算的必须是同一串字节，否则用户在面板里对上的指纹连上时又说不匹配
    assert.equal(
      rows[0].fingerprint,
      `SHA256:${crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('base64')}`
    )
  })

  test('base64 不合法的条目：指纹留空并标 malformed，不拿假指纹冒充', () => {
    const rows = listKnownHostRows(sample)
    const bad = rows[5]
    assert.equal(bad.malformed, true)
    assert.equal(bad.fingerprint, '')
    assert.equal(rows[0].malformed, false)
  })

  test('空内容 / 缺文件都不算错误', async () => {
    assert.deepEqual(listKnownHostRows(''), [])
    const missing = path.join(tmpDir(), 'known_hosts')
    const r = await listKnownHosts(missing)
    assert.equal(r.exists, false)
    assert.equal(r.mtimeMs, null)
    assert.deepEqual(r.rows, [])
    assert.equal(r.knownHostsPath, missing)
  })

  test('写盘再读回：append → list → 按行号删 → 再 list', async () => {
    const file = path.join(tmpDir(), 'known_hosts')
    await appendKnownHost({ host: 'a.example.com', port: 22, hostKey: Buffer.from(b64, 'base64'), knownHostsPath: file })
    await appendKnownHost({ host: 'b.example.com', port: 22022, hostKey: Buffer.from(b64b, 'base64'), knownHostsPath: file })
    const first = await listKnownHosts(file)
    assert.equal(first.exists, true)
    assert.ok(first.mtimeMs > 0, 'known_hosts 没有时间列，面板至少要给出文件 mtime')
    assert.deepEqual(first.rows.map(r => r.hostField), ['a.example.com', '[b.example.com]:22022'])
    const target = first.rows[0]
    const removed = await removeKnownHostLine({
      lineNo: target.lineNo,
      fingerprint: target.fingerprint,
      knownHostsPath: file
    })
    assert.equal(removed.hostField, 'a.example.com')
    const after = await listKnownHosts(file)
    assert.deepEqual(after.rows.map(r => r.hostField), ['[b.example.com]:22022'])
    // 删空一条后剩下的那行仍是合法文件：结尾换行、行数对得上
    const raw = fs.readFileSync(file, 'utf8')
    assert.ok(raw.endsWith('\n'), '重写把结尾换行丢了')
    assert.equal(raw.split('\n').filter(Boolean).length, 1)
  })

  test('哈希条目只能按行号 + 指纹删（removeKnownHost 按 host 匹配对它无效）', async () => {
    const file = path.join(tmpDir(), 'known_hosts')
    fs.writeFileSync(file, sample)
    const hashed = (await listKnownHosts(file)).rows.find(r => r.hashed)
    assert.ok(hashed, '样本里没有哈希条目')
    const removed = await removeKnownHostLine({
      lineNo: hashed.lineNo,
      fingerprint: hashed.fingerprint,
      knownHostsPath: file
    })
    assert.equal(removed.lineNo, hashed.lineNo)
    const left = await listKnownHosts(file)
    assert.equal(left.rows.some(r => r.hashed), false)
    assert.equal(left.rows.length, 5, '删一行少了一行，别的行不能跟着没')
  })

  test('行号与指纹不符就拒绝：列表读到点击之间文件被别人动过', async () => {
    const file = path.join(tmpDir(), 'known_hosts')
    fs.writeFileSync(file, sample)
    const rows = (await listKnownHosts(file)).rows
    const stale = rows[0]
    // 模拟外部改动：删掉首行注释，原行号 3 现在指向另一把钥匙
    const shifted = fs.readFileSync(file, 'utf8').split('\n').slice(1).join('\n')
    fs.writeFileSync(file, shifted)
    await assert.rejects(
      () => removeKnownHostLine({ lineNo: stale.lineNo, fingerprint: stale.fingerprint, knownHostsPath: file }),
      /no longer holds the expected key/
    )
    assert.equal(fs.readFileSync(file, 'utf8'), shifted, '拒绝的删除又把文件改了一遍')
  })

  test('非法行号、指向注释/空行的行号、缺指纹都拒绝', async () => {
    const file = path.join(tmpDir(), 'known_hosts')
    fs.writeFileSync(file, sample)
    const args = fp => ({ lineNo: 1, fingerprint: fp, knownHostsPath: file })
    await assert.rejects(() => removeKnownHostLine(args('SHA256:whatever')), /not a host key entry/)
    await assert.rejects(() => removeKnownHostLine(args('')), /not a host key entry|no longer holds/)
    for (const bad of [0, -1, 1.5, 'x', null, undefined]) {
      await assert.rejects(
        () => removeKnownHostLine({ ...args('SHA256:z'), lineNo: bad }),
        /positive integer/,
        String(bad)
      )
    }
    assert.equal(fs.readFileSync(file, 'utf8'), sample, '拒绝的删除不该动文件')
  })

  test('缺 fingerprint 参数时不删（避免渲染层漏传就盲删一行）', async () => {
    const file = path.join(tmpDir(), 'known_hosts')
    fs.writeFileSync(file, sample)
    await assert.rejects(
      () => removeKnownHostLine({ lineNo: 3, knownHostsPath: file }),
      /no longer holds the expected key/
    )
    assert.equal(fs.readFileSync(file, 'utf8'), sample)
  })
})

describe('G7 sshKeyOp 通道契约', () => {
  const ROOT = path.join(__dirname, '../../..')
  const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')
  // 注释里的说明性文字不算判据（同 remote-archive-ui.spec.js 的处理）
  const codeOf = src => src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  const ipcBlock = () => {
    const src = codeOf(read('src/app/lib/ipc.js'))
    const start = src.indexOf('sshKeyOp: async')
    assert.ok(start > -1, 'asyncGlobals 里没有 sshKeyOp')
    const end = src.indexOf('setPassword,', start)
    assert.ok(end > start, 'sshKeyOp 后面找不到下一个入口，切片切歪了')
    return src.slice(start, end)
  }

  test('四个动作都在通道里，未知动作抛错（与 dbSqlHistoryOp 同形状）', () => {
    const block = ipcBlock()
    for (const a of ['generate', 'listKnownHosts', 'deleteKnownHost', 'readPublicKey']) {
      assert.ok(block.includes("action === '" + a + "'"), '缺 ' + a)
    }
    assert.match(block, /throw new Error\('unknown sshKeyOp action: ' \+ action\)/)
  })

  test('渲染层递不进路径：通道只挑名字与行号，dir / knownHostsPath 不接受外部传值', () => {
    const block = ipcBlock()
    assert.match(block, /type: a\.type,\s*name: a\.name,\s*passphrase: a\.passphrase/)
    assert.ok(!/a\.dir/.test(block), 'dir 一旦来自渲染层，~/.ssh 就成了任意目录')
    assert.ok(!/a\.knownHostsPath/.test(block), 'known_hosts 路径同理')
  })
})
