const { describe, test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const { TerminalOutputArchive } = require('../../app/server/terminal-output-archive.js')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-lossless-'))

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function readAll (parts) {
  return Buffer.concat(parts.map(p => fs.readFileSync(p)))
}

describe('terminal output archive is lossless', () => {
  test('every byte, including split UTF-8 and control sequences, is archived', async () => {
    const dir = path.join(tmp, 'basic')
    const a = new TerminalOutputArchive({ pid: 'p1', dir })
    const chunks = [
      Buffer.from('hello\r\n'),
      Buffer.from([0x1b, 0x5b, 0x33, 0x31, 0x6d]),
      Buffer.from([0xe4]),
      Buffer.from([0xb8, 0xad]),
      'tail'
    ]
    const expected = Buffer.concat(chunks.map(c => Buffer.isBuffer(c) ? c : Buffer.from(c)))
    for (const c of chunks) {
      a.write(c)
    }
    assert.equal(a.stats().bytes, expected.length)
    const result = a.close()
    await a.drain()
    assert.equal(readAll(result.parts).equals(expected), true)
    assert.equal(result.sha256, crypto.createHash('sha256').update(expected).digest('hex'))
    assert.equal(result.error, null)
  })

  test('rotation changes the file, never drops a byte', async () => {
    const dir = path.join(tmp, 'rotate')
    const a = new TerminalOutputArchive({ pid: 'p2', dir, maxPartBytes: 8 })
    const chunks = [Buffer.from('12345'), Buffer.from('67890'), Buffer.from('abcde')]
    const expected = Buffer.concat(chunks)
    for (const c of chunks) {
      a.write(c)
    }
    const result = a.close()
    await a.drain()
    assert.ok(result.parts.length >= 2, 'a full part must rotate to a new file')
    assert.equal(readAll(result.parts).equals(expected), true)
    assert.equal(result.bytes, 15)
  })

  test('empty chunks and writes after close are no-ops', () => {
    const a = new TerminalOutputArchive({ pid: 'p3', dir: path.join(tmp, 'empty') })
    a.write('')
    a.write(Buffer.alloc(0))
    a.write('x')
    assert.equal(a.stats().bytes, 1)
    const first = a.close()
    a.write('more')
    assert.equal(a.stats().bytes, 1)
    assert.equal(a.close().sha256, first.sha256)
  })

  test('an unusable archive path degrades visibly instead of losing bytes or the session', () => {
    const blocker = path.join(tmp, 'not-a-dir')
    fs.writeFileSync(blocker, 'x')
    const a = new TerminalOutputArchive({ pid: 'p4', dir: path.join(blocker, 'child') })
    assert.ok(a.stats().error, 'failure must be visible')
    assert.doesNotThrow(() => a.write(Buffer.from('still counted')))
    assert.equal(a.stats().bytes, Buffer.from('still counted').length)
    assert.equal(a.close().sha256, crypto.createHash('sha256').update('still counted').digest('hex'))
  })

  // 归档名要能认出是哪个终端：logName（标题_主机_tabId）进文件名，
  // 非法字符替换、整名按 UTF-8 字节截断；没标签时退回 pid（tabId）。
  test('file name carries the terminal label, sanitized and byte-bounded', async () => {
    const dir = path.join(tmp, 'label')
    const a = new TerminalOutputArchive({
      pid: 'AbC1234',
      dir,
      label: '新连接_host/../x:y'
    })
    a.write('x')
    a.close()
    await a.drain()
    const name = path.basename(a.stats().parts[0])
    assert.ok(name.includes('新连接'), name)
    assert.ok(!/[<>:"\\|?*]/.test(name), 'no illegal characters: ' + name)
    assert.ok(!name.includes('/'), 'no path separators: ' + name)
    assert.match(name, /^lossless-.+-\d+-000\.bin$/)

    const longDir = path.join(tmp, 'label-long')
    const long = new TerminalOutputArchive({
      pid: 'p6',
      dir: longDir,
      label: '很长的标题'.repeat(40) + '_host_ukXi5xT_2026-11-19-10-39-41'
    })
    long.write('y')
    long.close()
    await long.drain()
    const longName = path.basename(long.stats().parts[0])
    assert.ok(Buffer.byteLength(longName) <= 200, String(Buffer.byteLength(longName)))
    assert.ok(longName.includes('很长的标题'), 'truncation must not mangle characters')
    assert.ok(longName.includes('ukXi5xT_2026-11-19-10-39-41'), 'the tab id tail survives: ' + longName)
    assert.ok(!longName.includes('\ufffd'), 'no replacement chars')

    const plainDir = path.join(tmp, 'label-absent')
    const plain = new TerminalOutputArchive({ pid: 'p9', dir: plainDir })
    plain.write('z')
    plain.close()
    await plain.drain()
    assert.match(path.basename(plain.stats().parts[0]), /^lossless-p9-/)
  })

  // I-5 前置条件：归档对"产出 vs 落盘 vs 丢失"的记账必须逐字节诚实，
  // 这样重放一致性才有可核对基线（producedBytes === bytes + lostBytes）。
  test('producedBytes accounts for every byte, and error is reported once (I-5)', async () => {
    const dir = path.join(tmp, 'accounting')
    let reported = 0
    const a = new TerminalOutputArchive({ pid: 'p5', dir, onError: () => { reported += 1 } })
    a.write(Buffer.from('abc'))
    a.write('def')
    assert.equal(a.stats().producedBytes, 6, 'produced counts all sourced bytes')
    assert.equal(a.stats().bytes, 6, 'all bytes hit disk on a healthy archive')
    assert.equal(a.stats().lostBytes, 0)
    assert.equal(reported, 0, 'no error while writes succeed')
    const result = a.close()
    await a.drain()
    assert.equal(result.producedBytes, 6)
    assert.equal(result.lostBytes, 0)
    assert.equal(result.bytes, 6)
  })
})
