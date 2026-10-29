/**
 * G3 远程文件预览：纯判定 + 两侧分片读
 *
 * 钉的是"预览不会把大文件整份搬进内存"这条底线，以及判定口径本身
 * （图片按扩展名整张、二进制看 NUL 密度、文本 2MB 截断）。I/O 用假流，
 * 不连真 SFTP；真机验收在 self-test 里。
 */

const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')

const {
  TEXT_PREVIEW_MAX,
  IMAGE_PREVIEW_MAX,
  HEX_PREVIEW_MAX,
  extOf,
  imageMimeOf,
  previewReadLimit,
  isBinaryBuffer,
  hexDump,
  buildPreview
} = require('../../app/common/remote-preview')

const {
  readRemoteFileChunk: sshChunk,
  statRemoteFile
} = require('../../app/server/sftp-file')

const {
  readRemoteFileChunk: ftpChunk
} = require('../../app/server/ftp-file')

describe('remote-preview: 扩展名与图片判定', () => {
  test('扩展名大小写不敏感，无扩展名返回空串', () => {
    assert.equal(extOf('a.PNG'), 'png')
    assert.equal(extOf('/tmp/foo.tar.gz'), 'gz')
    assert.equal(extOf('README'), '')
    assert.equal(extOf(''), '')
    assert.equal(extOf(null), '')
  })

  test('图片 mime 只认白名单，svg 也在内', () => {
    assert.equal(imageMimeOf('a.png'), 'image/png')
    assert.equal(imageMimeOf('a.JPEG'), 'image/jpeg')
    assert.equal(imageMimeOf('logo.svg'), 'image/svg+xml')
    assert.equal(imageMimeOf('a.txt'), '')
    assert.equal(imageMimeOf('a.png.txt'), '')
  })

  test('读多少：图片 10MB 档、其余 2MB 档，都不超过文件本身', () => {
    assert.equal(previewReadLimit('a.log', 10), 10)
    assert.equal(previewReadLimit('a.log', 10 * 1024 * 1024), TEXT_PREVIEW_MAX)
    assert.equal(previewReadLimit('a.png', 9 * 1024 * 1024), 9 * 1024 * 1024)
    assert.equal(previewReadLimit('a.png', 12 * 1024 * 1024), IMAGE_PREVIEW_MAX)
    assert.equal(previewReadLimit('a.bin', 0), 0)
    assert.equal(previewReadLimit('a.bin', undefined), 0)
    assert.equal(previewReadLimit('a.bin', -5), 0)
  })
})

describe('remote-preview: 二进制嗅探', () => {
  test('空 buffer 按文本（没什么可判的）', () => {
    assert.equal(isBinaryBuffer(Buffer.alloc(0)), false)
  })

  test('UTF-8 中文与普通文本不算二进制', () => {
    assert.equal(isBinaryBuffer(Buffer.from('中文日志 abc\n')), false)
  })

  test('NUL 占比超过 1% 判二进制', () => {
    const n = 800
    const buf = Buffer.alloc(n)
    // 10/800 = 1.25% > 1%
    for (let i = 0; i < 10; i++) {
      buf[i * 10] = 0
    }
    assert.equal(isBinaryBuffer(buf), true)
  })

  test('只看前 8KB：夹在文件深处的 NUL 不影响判定', () => {
    const buf = Buffer.alloc(16 * 1024, 0x41)
    buf.writeUInt8(0, 12 * 1024)
    assert.equal(isBinaryBuffer(buf), false)
  })
})

describe('remote-preview: 十六进制转储', () => {
  test('每行 16 字节，偏移 8 位十六进制，不可打印字节显示点', () => {
    const buf = Buffer.from('AB\0CD')
    const dump = hexDump(buf)
    assert.match(dump, /^00000000 {2}41 42 00 43 44/)
    assert.ok(dump.endsWith('|AB.CD|'), dump)
  })

  test('超过 4KB 只转前 4KB', () => {
    const buf = Buffer.alloc(HEX_PREVIEW_MAX + 32, 0x41)
    const dump = hexDump(buf)
    const lines = dump.split('\n')
    assert.equal(lines.length, HEX_PREVIEW_MAX / 16)
    assert.match(lines[lines.length - 1], /^00000ff0/)
  })
})

describe('remote-preview: 组装预览数据', () => {
  const stats = { size: 10, mtime: 1700000000, mode: 0o100644 }

  test('文本：UTF-8 解码 + 未截断', () => {
    const r = buildPreview({
      name: 'a.log',
      ...stats,
      buffer: Buffer.from('hello 世界')
    })
    assert.equal(r.kind, 'text')
    assert.equal(r.text, 'hello 世界')
    assert.equal(r.truncated, false)
    assert.equal(r.bytes, Buffer.from('hello 世界').length)
  })

  test('文本：读到的比文件小就是截断（大文件只读文件头）', () => {
    const r = buildPreview({
      name: 'big.log',
      size: 100 * 1024 * 1024,
      mtime: 1,
      mode: 0o100644,
      buffer: Buffer.alloc(TEXT_PREVIEW_MAX, 0x41)
    })
    assert.equal(r.kind, 'text')
    assert.equal(r.truncated, true)
    assert.equal(r.size, 100 * 1024 * 1024)
  })

  test('图片：base64 + mime，不截断', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2])
    const r = buildPreview({ name: 'a.png', ...stats, buffer: buf })
    assert.equal(r.kind, 'image')
    assert.equal(r.mime, 'image/png')
    assert.equal(r.base64, buf.toString('base64'))
    assert.equal(r.truncated, true) // stats.size 10 > 7 字节
  })

  test('超过 10MB 的图片不走 base64，按内容嗅探', () => {
    const buf = Buffer.alloc(1024, 0x41)
    const r = buildPreview({
      name: 'huge.png',
      size: IMAGE_PREVIEW_MAX + 1,
      mtime: 1,
      mode: 0o100644,
      buffer: buf
    })
    assert.notEqual(r.kind, 'image')
    assert.equal(r.kind, 'text')
  })

  test('二进制：给 hex，bytes 只算实际展示的前 4KB', () => {
    const buf = Buffer.alloc(HEX_PREVIEW_MAX * 2)
    const r = buildPreview({ name: 'a.bin', size: buf.length, mtime: 1, mode: 0o100644, buffer: buf })
    assert.equal(r.kind, 'binary')
    assert.equal(r.bytes, HEX_PREVIEW_MAX)
    assert.equal(r.hex.split('\n').length, HEX_PREVIEW_MAX / 16)
  })

  test('空文件：文本且空内容', () => {
    const r = buildPreview({ name: 'empty.txt', size: 0, mtime: 0, mode: 0, buffer: Buffer.alloc(0) })
    assert.equal(r.kind, 'text')
    assert.equal(r.text, '')
    assert.equal(r.truncated, false)
  })
})

// 假 SFTP：createReadStream 按 start/end 吐数据，stat 走回调
function fakeSftp (content, statImpl) {
  return {
    calls: [],
    createReadStream (path, opts) {
      this.calls.push({ path, ...opts })
      const start = opts.start || 0
      const end = typeof opts.end === 'number' ? opts.end : content.length - 1
      const chunk = content.subarray(start, Math.min(end + 1, content.length))
      const rs = Readable.from([chunk])
      return rs
    },
    stat (path, cb) {
      statImpl(path, cb)
    }
  }
}

describe('sftp-file: 分片读与 stat', () => {
  test('start/end 透传给 createReadStream，返回该段 Buffer', async () => {
    const sftp = fakeSftp(Buffer.from('0123456789'))
    const buf = await sshChunk(sftp, '/a.txt', 2, 5)
    assert.equal(buf.toString(), '2345')
    assert.equal(sftp.calls[0].start, 2)
    assert.equal(sftp.calls[0].end, 5)
  })

  test('end 超过 EOF 时按实际结尾收', async () => {
    const sftp = fakeSftp(Buffer.from('abc'))
    const buf = await sshChunk(sftp, '/a.txt', 1, 99)
    assert.equal(buf.toString(), 'bc')
  })

  test('源流报错要传出去（不能挂住）', async () => {
    const sftp = {
      createReadStream () {
        const rs = new Readable({
          read () {
            this.destroy(new Error('no such file'))
          }
        })
        return rs
      }
    }
    await assert.rejects(() => sshChunk(sftp, '/nope', 0, 1), /no such file/)
  })

  test('stat 归一：目录按 mode 判、时间原样（秒）', async () => {
    const sftp = fakeSftp(Buffer.alloc(0), (path, cb) => {
      cb(null, { size: 12, mtime: 1700, mode: 0o040755 })
    })
    const r = await statRemoteFile(sftp, '/dir')
    assert.deepEqual(r, { size: 12, mtime: 1700, mode: 0o040755, isDirectory: true })
  })

  test('stat 文件不是目录', async () => {
    const sftp = fakeSftp(Buffer.alloc(0), (path, cb) => {
      cb(null, { size: 5, mtime: 1, mode: 0o100644 })
    })
    assert.equal((await statRemoteFile(sftp, '/a.txt')).isDirectory, false)
  })

  test('stat 出错要 reject', async () => {
    const sftp = fakeSftp(Buffer.alloc(0), (path, cb) => {
      cb(new Error('permission denied'))
    })
    await assert.rejects(() => statRemoteFile(sftp, '/root/x'), /permission denied/)
  })
})

// 假 FTP client：downloadTo 模拟"从 start 起把 content 分块写进来"
function fakeFtp (content) {
  return {
    calls: [],
    downloadTo (writable, path, start) {
      this.calls.push({ path, start })
      return new Promise((resolve, reject) => {
        let off = start || 0
        const step = () => {
          if (writable.destroyed) {
            // basic-ftp 在流被销毁后的典型收场：拒绝
            reject(new Error('destination stream closed'))
            return
          }
          if (off >= content.length) {
            writable.end()
            resolve('ok')
            return
          }
          const chunk = content.subarray(off, Math.min(off + 4, content.length))
          off += chunk.length
          writable.write(chunk, () => setImmediate(step))
        }
        step()
      })
    }
  }
}

describe('ftp-file: 分片读（攒够就停，内存只保这一段）', () => {
  test('start 透传（REST 偏移），只保留请求长度', async () => {
    const client = fakeFtp(Buffer.from('0123456789'))
    const buf = await ftpChunk(client, '/a.txt', 2, 5)
    assert.equal(buf.toString(), '2345')
    assert.equal(client.calls[0].start, 2)
  })

  test('请求超出文件长度时按实际给', async () => {
    const client = fakeFtp(Buffer.from('abc'))
    const buf = await ftpChunk(client, '/a.txt', 0, 99)
    assert.equal(buf.toString(), 'abc')
  })

  test('下载失败且不足请求长度时 reject', async () => {
    const client = {
      downloadTo () {
        return Promise.reject(new Error('connection lost'))
      }
    }
    await assert.rejects(() => ftpChunk(client, '/a.txt', 0, 100), /connection lost/)
  })

  test('已攒够请求长度后被中止，按成功收（不以"流关闭"报错）', async () => {
    // 本用例靠 fakeFtp 的 destroyed 分支触发"中止后拒绝"，必须真的把流销毁：
    // 给一个 8 字节 content、请求 4 字节 → 第二次写之前已 settled 并 destroy
    const client = fakeFtp(Buffer.from('01234567'))
    const buf = await ftpChunk(client, '/a.txt', 0, 3)
    assert.equal(buf.toString(), '0123')
  })
})
