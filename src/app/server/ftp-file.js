const { Readable, Writable } = require('stream')

async function readRemoteFile (client, remotePath) {
  return new Promise((resolve, reject) => {
    let data = ''
    const writable = new Writable({
      write (chunk, encoding, callback) {
        data += chunk.toString()
        callback()
      }
    })

    client.downloadTo(writable, remotePath)
      .then(() => resolve(data))
      .catch(reject)
  })
}

async function writeRemoteFile (client, remotePath, str) {
  const readable = new Readable({
    read () {
      this.push(str)
      this.push(null)
    }
  })

  return client.uploadFrom(readable, remotePath)
}

/**
 * 只取文件一段（G3 预览用）。FTP 没有 SFTP 那样的 end 参数，basic-ftp 只支持
 * startAt（REST），所以这里从 start 起下，**攒够 limit 就主动收尾**并丢弃后续
 * 数据 —— 内存只保这一段，不会把大文件整份搬进来。
 *
 * 收尾后 basic-ftp 仍会往已 destroy 的流里写，它会以拒绝收场；只要已经攒够
 * 请求的字节数，这个拒绝按成功处理（下面 finish 里的 `bytes >= limit`）。
 */
function readRemoteFileChunk (client, remotePath, start = 0, end = 0) {
  const from = Math.max(0, Number(start) || 0)
  const limit = Math.max(0, (Number(end) || 0) - from + 1)
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    let settled = false
    const finish = (err) => {
      if (settled) {
        return
      }
      settled = true
      if (err && bytes < limit) {
        reject(err)
      } else {
        resolve(Buffer.concat(chunks))
      }
    }
    const writable = new Writable({
      write (chunk, encoding, callback) {
        if (bytes < limit) {
          const take = chunk.subarray(0, limit - bytes)
          chunks.push(take)
          bytes += take.length
        }
        if (bytes >= limit && !settled) {
          settled = true
          resolve(Buffer.concat(chunks))
          // 下一拍再销毁：让本次 write 的 callback 先落地，避免在写回调里
          // 同步销毁自己
          setImmediate(() => writable.destroy())
        }
        callback()
      }
    })
    writable.on('error', finish)
    writable.on('finish', () => finish(null))
    client.downloadTo(writable, remotePath, from).then(
      () => finish(null),
      err => finish(err)
    )
  })
}

module.exports = {
  readRemoteFile,
  writeRemoteFile,
  readRemoteFileChunk
}
