/**
 * terminal/sftp/serial class
 */

const log = require('../common/log')
const { TerminalBase } = require('./session-base')
const net = require('net')
const proxySock = require('./socks')
const { createHopProxy } = require('./session-hop')
const globalState = require('./global-state')

class TerminalVnc extends TerminalBase {
  init = async () => {
    globalState.setSession(this.pid, this)
    return Promise.resolve(this)
  }

  start = async (width, height) => {
    if (this.isRunning) {
      return
    }
    this.isRunning = true
    if (this.channel) {
      this.channel.close()
      delete this.channel
    }
    const {
      host,
      port
    } = this.initOptions
    const info = await this.hop()
    const target = net.createConnection({
      port,
      host,
      ...info
    })
    this.channel = target
    target.on('data', this.onData)
    target.on('end', this.kill)
    target.on('error', this.onError)

    this.ws.on('message', this.onMsg)
    this.ws.on('close', this.kill)
    // 仅供日志/诊断：VNC 的帧缓冲尺寸由 server 端决定（客户端发 SetDesktopSize
    // 才会改），中继不碰这两个值。路由必须按 (width, height) 传，
    // 之前把整个 query 当 width 递进来，这里记录到的是个对象
    this.width = width
    this.height = height
  }

  hop = async () => {
    const {
      host,
      port,
      readyTimeout
    } = this.initOptions
    const { proxyUrl, ssh } = await createHopProxy(this.initOptions)
    if (ssh) {
      this.ssh = ssh
    }
    return proxyUrl
      ? proxySock({ readyTimeout, host, port, proxy: proxyUrl })
      : undefined
  }

  onMsg = (msg) => {
    this.channel.write(msg)
  }

  onData = (data) => {
    try {
      this.ws?.send(data)
    } catch (e) {
      log.error('vnc connection send data error', e)
    }
  }

  resize () {

  }

  onError = (err) => {
    log.error('vnc error', err)
    this.kill()
  }

  test = async () => {
    return new Promise((resolve, reject) => {
      const {
        host,
        port
      } = this.initOptions
      return this.hop()
        .then(info => {
          net.createConnection({
            port,
            host,
            ...info
          }, () => {
            resolve(true)
          })
        })
        .catch(err => reject(err))
    })
  }

  kill = () => {
    log.debug('Closed vnc session ' + this.pid)
    if (this.ws) {
      this.ws.close()
      delete this.ws
    }
    if (this.ssh) {
      this.ssh.kill()
      delete this.ssh
    }
    this.channel && this.channel.end()
    if (this.sessionLogger) {
      this.sessionLogger.destroy()
    }
    globalState.removeSession(this.pid)
  }
}

exports.session = async function (initOptions, ws) {
  const term = new TerminalVnc(initOptions, ws)
  await term.init()
  return term
}

/**
 * test ssh connection
 * @param {object} options
 */
exports.test = (options) => {
  const inst = new TerminalVnc(options, undefined, true)
  return inst.test()
    .then(() => {
      inst.kill()
      return true
    })
    .catch(() => {
      inst.kill()
      return false
    })
}
