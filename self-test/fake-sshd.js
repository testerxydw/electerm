/**
 * G9-4 自测用的假 sshd + 假 TCP 服务（只在自测进程里跑，绝不对外）
 *
 * 为什么要它：隧道"运行中"这三个字，只有端口真的在听、字节真的能穿过去才算数。
 * 单测（session-ssh-tunnel-op.spec.js）钉的是主进程的登记与启停判据，这里要钉的是
 * 一次真握手之后的真转发，所以得有一个真的会说 SSH 协议的对端。
 *
 * 覆盖的协议面（正好是 src/app/server/ssh-tunnel.js 用到的那几条）：
 *   - password 认证 + session/env/pty/shell（会话本身要活着）
 *   - global request: tcpip-forward / cancel-tcpip-forward（-R 那两类隧道开与关远端口）
 *   - forwarded-tcpip 通道：远端口收到连接 → client.forwardOut 推给 electerm
 *   - direct-tcpip 通道（'tcpip' 事件）：electerm 本地口收到的连接 → 这里去拨目标端口
 *
 * 未知的全局请求一律 accept（OpenSSH 对不认识的请求也是回成功），不干扰会话。
 */
const net = require('net')
const { once } = require('node:events')
const { Server, utils } = require('@electerm/ssh2')

const HOST_KEY = utils.generateKeyPairSync('ed25519', {
  comment: 'electerm-g9-self-test'
})

/** known_hosts 里那一行：非标准端口要写成 [127.0.0.1]:<port>，否则匹配不上 */
function knownHostsLine (port) {
  const pub = HOST_KEY.public.trim().split(/\s+/)
  return `[127.0.0.1]:${port} ${pub[0]} ${pub[1]}`
}

function freePort () {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/** 端口上有没有人在听（连得上=有人在听） */
function portOpen (port) {
  return new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1')
    c.once('connect', () => {
      c.destroy()
      resolve(true)
    })
    c.once('error', () => resolve(false))
  })
}

/**
 * 穿隧道走一行字节，拿回回声。
 * 返回 null 表示这一趟没走通（连不上、或没回声）—— 判据只看有没有回，不看日志。
 */
function roundTrip (port, payload, timeout = 4000) {
  return new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1')
    let got = ''
    let done = false
    const finish = (v) => {
      if (done) {
        return
      }
      done = true
      clearTimeout(timer)
      c.destroy()
      resolve(v)
    }
    const timer = setTimeout(() => finish(null), timeout)
    c.once('error', () => finish(null))
    c.on('data', (d) => {
      got += d.toString()
      if (got.indexOf(payload) >= 0) {
        finish(got)
      }
    })
    c.on('connect', () => c.write(payload + '\n'))
  })
}

/**
 * 走 SOCKS5 的一次真往返：握手 → CONNECT 到 dstHost:dstPort → 写一行 → 等回声。
 * 手写而不引库，是因为要验的正是"这个监听口说的是 SOCKS5 这句话"——
 * 用库的话协议对不上也照样连得上，判据就空转了。
 * 只支持 IPv4 目标（ATYP=1）：自测里所有目标都是 127.0.0.1。
 */
function socksRoundTrip (port, dstHost, dstPort, payload, timeout = 8000) {
  return new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1')
    let buf = Buffer.alloc(0)
    let stage = 0
    let done = false
    const finish = (v) => {
      if (done) {
        return
      }
      done = true
      clearTimeout(timer)
      c.destroy()
      resolve(v)
    }
    const timer = setTimeout(() => finish(null), timeout)
    c.once('error', () => finish(null))
    c.on('connect', () => c.write(Buffer.from([5, 1, 0])))
    const pump = () => {
      if (stage === 0) {
        if (buf.length < 2) {
          return
        }
        if (buf[0] !== 5 || buf[1] !== 0) {
          return finish(null)
        }
        buf = buf.slice(2)
        const req = Buffer.alloc(10)
        req[0] = 5
        req[1] = 1 // CONNECT
        req[3] = 1 // IPv4
        dstHost.split('.').forEach((n, i) => {
          req[4 + i] = Number(n)
        })
        req.writeUInt16BE(dstPort, 8)
        c.write(req)
        stage = 1
      }
      if (stage === 1) {
        if (buf.length < 10) {
          return
        }
        if (buf[1] !== 0) {
          return finish(null)
        }
        buf = buf.slice(10)
        c.write(payload + '\n')
        stage = 2
      }
      if (stage === 2) {
        const text = buf.toString()
        if (text.indexOf(payload) >= 0) {
          return finish(text)
        }
        if (buf.length > 4096) {
          return finish(null)
        }
      }
    }
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      pump()
    })
  })
}

/**
 * 端口还能不能被自己 bind 上 —— 「停止」到底有没有把监听口释放，
 * 只有让另一个进程去占一次才算数（连得上只能证明有人在听，不能证明没人听）。
 */
function bindable (port) {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

/** 按住一个端口不放：用来演 EADDRINUSE 那条错误行 */
async function holdPort (port) {
  const blocker = net.createServer()
  await new Promise((resolve, reject) => {
    blocker.once('error', reject)
    blocker.listen(port, '127.0.0.1', resolve)
  })
  return () => new Promise((resolve) => blocker.close(resolve))
}

/** 只会把每一行原样回给对端的 TCP 服务，顺带记自己被拨过几次 */
async function startEcho (label) {
  const hits = []
  const sockets = new Set()
  const server = net.createServer((sock) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    sock.on('error', () => sockets.delete(sock))
    let buf = ''
    sock.on('data', (d) => {
      buf += d.toString()
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) {
        hits.push(`${label}:${line}`)
        sock.write(line + '\n')
      }
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    port: server.address().port,
    hits,
    close () {
      for (const s of sockets) {
        s.destroy()
      }
      return new Promise((resolve) => server.close(resolve))
    }
  }
}

/**
 * @returns {Promise<{
 *   port, knownHostsLine, clients(), forwardLog, dialed, execLog,
 *   forwardedPorts(), disconnectAll(), close()
 * }>}
 */
async function startFakeSshd ({
  username,
  password,
  banner = 'electerm g9 fake sshd ready\n'
}) {
  const clients = new Set()
  // 谁开了远端口、谁被取消 —— 「停止」按钮到底有没有把 cancel 发到服务端，只有这里知道
  const forwardLog = []
  const forwarded = new Map() // '127.0.0.1:2222' -> net.Server
  const dialed = [] // direct-tcpip 的目的地（本地/动态隧道真正拨出去的地方）
  const execLog = [] // 会话期间客户端 exec 过来的命令（真 sshd 会应答，这里也应答）
  const shells = new Set()

  const server = new Server({ hostKeys: [HOST_KEY.private] }, (client) => {
    clients.add(client)
    client.on('close', () => clients.delete(client))
    client.on('error', () => clients.delete(client))
    client.on('authentication', (ctx) => {
      if (ctx.method === 'none') {
        return ctx.reject(['password'])
      }
      if (ctx.method === 'password' && ctx.username === username && ctx.password === password) {
        return ctx.accept()
      }
      return ctx.reject(['password'])
    })
    client.on('ready', () => {
      client.on('session', (accept) => {
        const sshSession = accept()
        // env/pty 不带 wantReply，accept 可能是 undefined：调错了整条通道就断
        sshSession.on('env', (a) => a && a())
        sshSession.on('pty', (a) => a && a())
        // exec 必须应：真 sshd 会应。不应的话客户端那条 exec 回调一直悬着，
        // 断线时才带着 "Unable to exec"  reject 回来，看起来像隧道面板崩了。
        sshSession.on('exec', (accept2, reject2, info) => {
          const stream = accept2()
          if (!stream) {
            return
          }
          execLog.push(String(info && info.command))
          stream.write('electerm-fake-sshd-exec-ok\n')
          stream.exit(0)
          stream.end()
        })
        sshSession.on('shell', (accept2) => {
          const stream = accept2()
          if (!stream) {
            return
          }
          shells.add(stream)
          stream.on('close', () => shells.delete(stream))
          stream.write(banner)
          stream.on('data', (d) => stream.write(`echo-shell:${d}`))
        })
      })

      client.on('request', (accept, reject, name, info) => {
        const key = `${info && info.bindAddr}:${info && info.bindPort}`
        if (name === 'tcpip-forward') {
          forwardLog.push({ name, key, at: Date.now() })
          const sockets = new Set()
          const listener = net.createServer((sock) => {
            sockets.add(sock)
            sock.on('close', () => sockets.delete(sock))
            sock.on('error', () => sockets.delete(sock))
            client.forwardOut(
              info.bindAddr,
              // destPort 必须等于客户端当初申请的那个端口，否则 electerm 认不出是自己的隧道
              info.bindPort,
              sock.remoteAddress,
              sock.remotePort,
              (err, chan) => {
                if (err) {
                  if (process.env.G9_FAKE_SSHD_DEBUG) {
                    console.log('[fake-sshd] forwardOut error', err.message)
                  }
                  sock.destroy()
                  return
                }
                sock.pipe(chan).pipe(sock)
              })
          })
          listener.on('error', () => {
            forwarded.delete(key)
            if (accept) {
              accept()
            } else if (reject) {
              reject()
            }
          })
          listener.listen(info.bindPort, info.bindAddr, () => {
            forwarded.set(key, { listener, sockets })
            if (accept) {
              accept(listener.address().port)
            }
          })
          return
        }
        if (name === 'cancel-tcpip-forward') {
          forwardLog.push({ name, key, at: Date.now() })
          const held = forwarded.get(key)
          forwarded.delete(key)
          if (held) {
            for (const s of held.sockets) {
              s.destroy()
            }
            held.listener.close()
          }
          if (accept) {
            accept()
          } else if (reject) {
            reject()
          }
          return
        }
        if (accept) {
          accept()
        } else if (reject) {
          reject()
        }
      })

      // electerm 的本地/动态隧道每来一条连接就开一条 direct-tcpip，
      // 目标地址端口由它给定 —— 这里真去拨，转发才算真发生过
      client.on('tcpip', (accept, reject, info) => {
        dialed.push(`${info.destIP}:${info.destPort}`)
        const target = net.connect(info.destPort, info.destIP)
        const stream = accept()
        if (!stream) {
          target.destroy()
          return
        }
        const kill = () => {
          target.destroy()
          stream.destroy()
        }
        target.on('error', kill)
        stream.on('error', kill)
        stream.on('close', () => target.destroy())
        target.on('close', () => stream.destroy())
        target.pipe(stream).pipe(target)
      })
    })
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port

  return {
    port,
    knownHostsLine: knownHostsLine(port),
    forwardLog,
    dialed,
    execLog,
    clients: () => clients.size,
    forwardedPorts: () => [...forwarded.keys()],
    async disconnectAll () {
      // 服务端 Client 只有 end()（它会关掉底层 socket），没有 destroy()
      for (const c of [...clients]) {
        c.end()
      }
      // 给 'close' 落地留一点时间，否则下一条判据会读到还没散的连接数。
      // 别改成等 process 'tick'：这个循环里一直有活跃 io，tick 可以长时间不发，
      // 实测把整轮自测吊死在这里。
      await new Promise(resolve => setTimeout(resolve, 800))
    },
    async close () {
      for (const c of [...clients]) {
        c.end()
      }
      for (const { listener, sockets } of forwarded.values()) {
        for (const s of sockets) {
          s.destroy()
        }
        listener.close()
      }
      forwarded.clear()
      for (const s of shells) {
        s.close()
      }
      await new Promise((resolve) => server.close(resolve))
    }
  }
}

module.exports = {
  startFakeSshd,
  startEcho,
  holdPort,
  freePort,
  portOpen,
  bindable,
  roundTrip,
  socksRoundTrip,
  knownHostsLine
}
