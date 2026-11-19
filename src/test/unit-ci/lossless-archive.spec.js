// 完整输出归档（lossless_output）的目录约定、统计与清理。
// 纯逻辑 + 临时目录实测，不碰真实用户数据（AGENTS.md §2：临时目录走 os.tmpdir()）。
const { describe, test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
let root

const la = require(path.join(ROOT, 'src/app/lib/lossless-archive.js'))

const DAY = 24 * 60 * 60 * 1000

function mkDir (name) {
  const d = path.join(root, name)
  fs.mkdirSync(d, { recursive: true })
  return d
}

function writePart (dir, name, size, ageDays) {
  const full = path.join(dir, name)
  fs.writeFileSync(full, Buffer.alloc(size, 0x61))
  const t = new Date(Date.now() - ageDays * DAY)
  fs.utimesSync(full, t, t)
}

function file (name, size, ageDays) {
  return { name, size, mtimeMs: Date.now() - ageDays * DAY }
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-lossless-spec-'))
})

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('lossless archive', () => {
  test('目录名是单点真源，session-server 不再手写字符串', () => {
    assert.equal(la.ARCHIVE_SUBDIR, 'lossless_output')
    assert.equal(la.archiveDir('/tmp/base'), path.join('/tmp/base', 'lossless_output'))
    const serverSrc = fs.readFileSync(
      path.join(ROOT, 'src/app/server/session-server.js'), 'utf8'
    )
    assert.match(serverSrc, /ARCHIVE_SUBDIR/)
    assert.doesNotMatch(serverSrc, /'lossless_output'/)
  })

  test('ipc 暴露打开/定位/统计/清理四个动作', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/app/lib/ipc.js'), 'utf8')
    for (const name of [
      'openLosslessArchiveDir',
      'revealLosslessArchive',
      'losslessArchiveInfo',
      'cleanLosslessArchive'
    ]) {
      assert.match(src, new RegExp('\\b' + name + '\\b'))
    }
  })

  test('resolveArchive 只收目录内的 .bin 裸文件名', () => {
    assert.equal(
      la.resolveArchive('/tmp/base', 'lossless-1.bin'),
      path.join('/tmp/base', 'lossless-1.bin')
    )
    assert.throws(() => la.resolveArchive('/tmp/base', '../secret.bin'))
    assert.throws(() => la.resolveArchive('/tmp/base', '/etc/passwd.bin'))
    assert.throws(() => la.resolveArchive('/tmp/base', 'lossless-1.txt'))
  })

  test('selectExpired：按天数取旧文件，0 取全部，非法值不清理', () => {
    const files = [file('a.bin', 10, 40), file('b.bin', 20, 10), file('c.bin', 30, 1)]
    assert.deepEqual(
      la.selectExpired(files, { days: 30 }).map(f => f.name),
      ['a.bin']
    )
    assert.deepEqual(
      la.selectExpired(files, { days: 0 }).map(f => f.name),
      ['a.bin', 'b.bin', 'c.bin']
    )
    assert.deepEqual(la.selectExpired(files, { days: 'x' }), [])
    assert.deepEqual(la.selectExpired(files, { days: 5 }).map(f => f.name), ['a.bin', 'b.bin'])
  })

  test('listArchive：只统计 .bin，汇总字节，按时间倒序，明细可截断', () => {
    const dir = mkDir('list')
    writePart(dir, 'lossless-1-100-000.bin', 100, 3)
    writePart(dir, 'lossless-2-200-000.bin', 200, 1)
    writePart(dir, 'keep.cast', 50, 0)
    const info = la.listArchive(dir)
    assert.equal(info.count, 2)
    assert.equal(info.bytes, 300)
    assert.deepEqual(info.files.map(f => f.name), [
      'lossless-2-200-000.bin',
      'lossless-1-100-000.bin'
    ])
    assert.equal(la.listArchive(dir, 1).files.length, 1)
    assert.equal(la.listArchive(dir, 1).count, 2)
  })

  test('cleanArchive：只删过期的 .bin，保留新文件与其它扩展名', () => {
    const dir = mkDir('clean-old')
    writePart(dir, 'lossless-old.bin', 10, 90)
    writePart(dir, 'lossless-new.bin', 20, 1)
    writePart(dir, 'keep.cast', 50, 0)
    const res = la.cleanArchive(dir, { days: 30 })
    assert.equal(res.removed, 1)
    assert.equal(res.freedBytes, 10)
    assert.equal(res.failed, 0)
    assert.ok(!fs.existsSync(path.join(dir, 'lossless-old.bin')))
    assert.ok(fs.existsSync(path.join(dir, 'lossless-new.bin')))
    assert.ok(fs.existsSync(path.join(dir, 'keep.cast')))
  })

  test('cleanArchive：days=0 清空全部归档但不碰其它文件', () => {
    const dir = mkDir('clean-all')
    writePart(dir, 'lossless-a.bin', 10, 90)
    writePart(dir, 'lossless-b.bin', 20, 1)
    writePart(dir, 'keep.cast', 50, 0)
    const res = la.cleanArchive(dir, { days: 0 })
    assert.equal(res.removed, 2)
    assert.equal(res.freedBytes, 30)
    assert.equal(la.listArchive(dir).count, 0)
    assert.ok(fs.existsSync(path.join(dir, 'keep.cast')))
  })

  test('目录不存在时统计为空、清理不抛', () => {
    const missing = path.join(root, 'nope')
    assert.deepEqual(la.listArchive(missing).count, 0)
    assert.deepEqual(la.cleanArchive(missing, { days: 0 }), { removed: 0, freedBytes: 0, failed: 0 })
  })
})
