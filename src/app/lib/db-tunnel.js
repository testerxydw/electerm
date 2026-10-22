/**
 * ssh tunnel for database connection test
 * Builds a local relay port through an ssh bookmark:
 *   local client -> 127.0.0.1:port -> ssh forwardOut -> dbHost:dbPort
 */

const net = require('net')
const log = require('../common/log')

const READY_TIMEOUT = 10000

/**
 * @param {Object} sshBookmark - decrypted ssh bookmark { host, port, username, password, privateKey }
 * @param {string} dbHost
 * @param {number} dbPort
 * @returns {Promise<{port: number, close: Function}>}
 */
function createDbTunnel (sshBookmark, dbHost, dbPort) {
  return new Promise((resolve, reject) => {
    const { Client } = require('@electerm/ssh2')
    const conn = new Client()
    let server = null
    let settled = false
    const timer = setTimeout(() => {
      finish(new Error('ssh tunnel ready timeout'))
    }, READY_TIMEOUT)

    const finish = (err, res) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (err) {
        try {
          conn.end()
        } catch (e) {
          // 清理失败不影响主错误上抛，仅留痕
          log.debug('db tunnel conn end cleanup fails:', e.message)
        }
        return reject(err)
      }
      resolve(res)
    }

    conn.on('ready', () => {
      server = net.createServer(sock => {
        conn.forwardOut(
          sock.remoteAddress, sock.remotePort, dbHost, dbPort,
          (err, stream) => {
            if (err) {
              log.error('db tunnel forwardOut error', err.message)
              sock.end()
              return
            }
            sock.pipe(stream).pipe(sock)
          }
        )
      })
      server.on('error', err => {
        finish(err)
      })
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port
        finish(null, {
          port,
          close: () => {
            try {
              server.close()
            } catch (e) {
              log.debug('db tunnel server close fails:', e.message)
            }
            try {
              conn.end()
            } catch (e) {
              log.debug('db tunnel conn close fails:', e.message)
            }
          }
        })
      })
    })
    conn.on('error', err => {
      finish(err)
    })

    const opts = {
      host: sshBookmark.host,
      port: sshBookmark.port || 22,
      username: sshBookmark.username || 'root',
      readyTimeout: READY_TIMEOUT,
      keepaliveInterval: 5000
    }
    if (sshBookmark.privateKey) {
      opts.privateKey = sshBookmark.privateKey
    }
    if (sshBookmark.password) {
      opts.password = sshBookmark.password
    }
    conn.connect(opts)
  })
}

module.exports = {
  createDbTunnel
}
