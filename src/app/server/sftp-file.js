/**
 * sftp read/write file
 */

const { Readable, Writable } = require('stream')

function createReadStreamFromString (str) {
  const s = new Readable()
  s._read = () => {}
  s.push(str)
  s.push(null)
  return s
}

class FakeWrite extends Writable {
  constructor (opts) {
    super(opts)
    this.opts = opts
  }

  _write (data, encoding, done) {
    this.opts.onData(data)
    done()
  }
}

function writeRemoteFile (sftp, path, str, mode) {
  return new Promise((resolve, reject) => {
    const writeStream = sftp.createWriteStream(path, {
      highWaterMark: 64 * 1024 * 4 * 4,
      mode
    })
    writeStream.on('close', () => {
      resolve('ok')
    })
    writeStream.on('error', (e) => {
      reject(e)
    })
    createReadStreamFromString(str).pipe(writeStream)
  })
}

function readRemoteFile (sftp, path) {
  return new Promise((resolve, reject) => {
    let final = Buffer.alloc(0)
    const writeStream = new FakeWrite({
      onData: data => {
        final = Buffer.concat(
          [final, data]
        )
      }
    })
    writeStream.on('finish', () => {
      resolve(final.toString())
    })
    writeStream.on('error', (e) => {
      reject(e)
    })
    const readStream = sftp.createReadStream(path, {
      highWaterMark: 64 * 1024 * 4 * 4
    })
    // pipe() forwards an error of the *destination*, not of the source: when the
    // remote open fails (no such file, a directory, permission denied) the read
    // stream emits 'error' and nothing downstream ever ends, so neither 'finish'
    // nor the write stream's own 'error' ever fires and this promise hangs for
    // good. That is what left sftp_read_file spinning in the AI agent. Handle
    // the source error here and settle the promise with it.
    readStream.on('error', (e) => {
      writeStream.destroy()
      reject(e)
    })
    readStream.pipe(writeStream)
  })
}

/**
 * 只取文件一段（G3 预览用）。start/end 都是闭区间字节偏移，与 ssh2 的
 * createReadStream 一致；end 超过 EOF 时按实际结尾收。
 *
 * 与 readRemoteFile 的区别：这里**不**把整个文件读进内存，调用方按
 * `previewReadLimit` 给出的上限传 end。
 */
function readRemoteFileChunk (sftp, path, start = 0, end = 0) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let settled = false
    const settle = (err, data) => {
      if (settled) {
        return
      }
      settled = true
      if (err) {
        reject(err)
      } else {
        resolve(data)
      }
    }
    const readStream = sftp.createReadStream(path, {
      start,
      end,
      highWaterMark: 64 * 1024 * 4
    })
    readStream.on('data', (data) => {
      chunks.push(data)
    })
    readStream.on('error', (e) => {
      settle(e)
    })
    // 'end' 先于 'close'；两者都兜一层，拿先到的那个收尾
    readStream.on('end', () => {
      settle(null, Buffer.concat(chunks))
    })
    readStream.on('close', () => {
      settle(null, Buffer.concat(chunks))
    })
  })
}

function statRemoteFile (sftp, path) {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (err, stats) => {
      if (err) {
        reject(err)
        return
      }
      const mode = Number(stats.mode) || 0
      resolve({
        size: Number(stats.size) || 0,
        // ssh2 给的是秒
        mtime: Number(stats.mtime) || 0,
        mode,
        isDirectory: (mode & 0o170000) === 0o040000
      })
    })
  })
}

module.exports = {
  readRemoteFile,
  writeRemoteFile,
  readRemoteFileChunk,
  statRemoteFile
}
