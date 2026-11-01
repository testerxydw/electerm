const log = require('../common/log')

/**
 * Every tunnel resolves { close }. close is idempotent because two things can
 * reach it: the runtime panel (stop this tunnel) and the ssh connection's own
 * 'close' event (the whole session is going away).
 */
function makeClose (fn) {
  let closed = false
  return () => {
    if (closed) {
      return
    }
    closed = true
    fn()
  }
}

function destroyAll (set) {
  for (const stream of set) {
    stream.destroy()
  }
  set.clear()
}

/**
 * A remote forward is a listening socket on the *server*, so dropping our
 * listeners is not enough - the server would keep accepting into a channel
 * nobody services. ssh2 throws when the connection is already gone (the 'close'
 * path here), and a plain EventEmitter stand-in (tests) has no method at all.
 */
function unforwardIn (conn, host, port, result) {
  if (typeof conn.unforwardIn !== 'function') {
    return
  }
  try {
    conn.unforwardIn(host, port, (err) => {
      if (err) {
        log.error(`Error cancelling forward for ${result}:`, err.message)
      }
    })
  } catch (e) {
    log.log(`skip unforward for ${result}: ${e.message}`)
  }
}

function forwardRemoteToLocal ({
  conn,
  sshTunnelRemotePort,
  sshTunnelLocalPort,
  sshTunnelRemoteHost = '127.0.0.1',
  sshTunnelLocalHost = '127.0.0.1'
}) {
  return new Promise((resolve, reject) => {
    const result = `remote:${sshTunnelRemoteHost}:${sshTunnelRemotePort} => local:${sshTunnelLocalHost}:${sshTunnelLocalPort}`
    const srcStreams = new Set()
    const localSockets = new Set()

    const handleTcpConnection = (info, accept, rejectConn) => {
      // Check if this connection is for this tunnel
      if (info.destPort !== sshTunnelRemotePort && info.destPort !== Number(sshTunnelRemotePort)) {
        return
      }

      const srcStream = accept() // Source stream for forwarding

      if (!srcStream) {
        log.error(`Failed to accept connection for tunnel ${result}`)
        return
      }

      srcStreams.add(srcStream)
      srcStream.on('close', () => {
        srcStreams.delete(srcStream)
      })

      // Add error handling for source stream immediately
      srcStream.on('error', (err) => {
        log.error(`Source stream error for tunnel ${result}:`, err)
      })

      // Connect the local machine source stream to the local port
      // Create a NEW server connection for each forwarded connection
      const server = require('net').connect(sshTunnelLocalPort, sshTunnelLocalHost)
      localSockets.add(server)

      // CRITICAL: Add error handling IMMEDIATELY before any async operations
      // This prevents unhandled errors from crashing the SSH session
      server.on('error', (err) => {
        log.error(`Server connection error for tunnel ${result}:`, err.message)
        // Just close this specific connection, don't break the tunnel
        srcStream.destroy()
        server.destroy()
      })

      server.on('close', () => {
        localSockets.delete(server)
        log.log(`Local server connection closed for tunnel ${result}`)
        srcStream.end()
      })

      srcStream.on('close', () => {
        server.destroy()
      })

      srcStream.pipe(server).pipe(srcStream)
    }

    const handleClose = () => {
      log.log(`SSH connection closed for tunnel ${result}`)
      close()
    }

    const close = makeClose(() => {
      conn.removeListener('tcp connection', handleTcpConnection)
      conn.removeListener('close', handleClose)
      destroyAll(srcStreams)
      destroyAll(localSockets)
      unforwardIn(conn, sshTunnelRemoteHost, sshTunnelRemotePort, result)
    })

    conn.on('tcp connection', handleTcpConnection)

    conn.on('close', handleClose)

    // Forward the remote server's port to the local machine's port
    conn.forwardIn(sshTunnelRemoteHost, sshTunnelRemotePort, (err) => {
      if (err) {
        log.error('Error forwarding port:', err)
        close()
        return reject(err)
      }
      log.log(`Port forwarded: ${result}`)
      resolve({ close })
    })
  })
}

function forwardLocalToRemote ({
  conn,
  sshTunnelRemotePort,
  sshTunnelLocalPort,
  sshTunnelRemoteHost = '127.0.0.1',
  sshTunnelLocalHost = '127.0.0.1'
}) {
  return new Promise((resolve, reject) => {
    const activeSockets = new Set()
    const remoteSockets = new Set()
    const localServer = require('net').createServer((socket) => {
      // ⬇️ 2. Add new sockets to the set and remove them when they close
      activeSockets.add(socket)
      socket.on('close', () => {
        activeSockets.delete(socket)
      })

      socket.on('error', (err) => {
        log.error('Client socket error:', err)
        socket.end()
      })

      conn.forwardOut(sshTunnelLocalHost, sshTunnelLocalPort, sshTunnelRemoteHost, sshTunnelRemotePort, (err, remoteSocket) => {
        if (err) {
          log.error('Error forwarding connection:', err)
          socket.destroy()
          // Don't reject - just close this connection
          // Rejecting would break the entire tunnel
          return
        }

        // The client may have gone away (e.g. sent RST) while the channel was
        // opening. Its 'close' already fired, so the listener below would never
        // run and the channel and remote connection would stay open.
        if (socket.destroyed) {
          remoteSocket.destroy()
          return
        }

        remoteSockets.add(remoteSocket)
        remoteSocket.on('close', () => {
          remoteSockets.delete(remoteSocket)
          socket.destroy()
        })

        // Add error handlers immediately
        remoteSocket.on('error', (err) => {
          log.error('Remote socket error:', err)
          socket.destroy()
        })

        socket.on('close', () => {
          remoteSocket.destroy()
        })

        socket.pipe(remoteSocket).pipe(socket)
      })
    })

    const handleClose = () => {
      log.log('SSH connection closed, closing local server.')
      close()
    }

    const close = makeClose(() => {
      conn.removeListener('close', handleClose)
      // destroy the sockets first: a server with open connections would not
      // finish closing and its port would stay taken
      destroyAll(activeSockets)
      destroyAll(remoteSockets)
      localServer.close()
    })

    localServer.listen(sshTunnelLocalPort, sshTunnelLocalHost, () => {
      log.log(`Local server listening on port ${sshTunnelLocalPort}`)
      resolve({ close })
    })
    localServer.on('error', (err) => {
      log.error('Error listening for local connections:', err)
      close()
      reject(err)
    })

    conn.on('close', handleClose)
  })
}

function dynamicForward ({
  conn,
  sshTunnelLocalPort,
  sshTunnelLocalHost = '127.0.0.1'
}) {
  const socks = require('socksv5-server')
  return new Promise((resolve, reject) => {
    const streams = new Set()
    const track = (stream) => {
      streams.add(stream)
      stream.on('close', () => streams.delete(stream))
    }
    const dproxyServer = socks.createServer((info, accept, deny) => {
      conn.forwardOut(
        info.srcAddr,
        info.srcPort,
        info.dstAddr,
        info.dstPort,
        (err, stream) => {
          if (err) {
            log.error('SOCKS forward error:', err)
            deny()
            // Don't reject - just deny this connection
            // Rejecting would break the entire tunnel
            return
          }
          const clientSocket = accept(true)
          if (clientSocket) {
            track(stream)
            track(clientSocket)

            // Add error handling for stream immediately
            stream.on('error', (err) => {
              log.error('SOCKS stream error:', err)
              clientSocket.destroy()
            })

            // Add error handling for client socket immediately
            clientSocket.on('error', (err) => {
              log.error('SOCKS client socket error:', err)
              stream.destroy()
            })

            stream.on('close', () => {
              clientSocket.destroy()
            })

            clientSocket.on('close', () => {
              stream.destroy()
            })

            stream.pipe(clientSocket).pipe(stream)
          }
        })
    })
    const handleClose = () => close()
    const close = makeClose(() => {
      conn.removeListener('close', handleClose)
      destroyAll(streams)
      dproxyServer.close()
    })
    dproxyServer.on('error', (err) => {
      log.error('Error listening for local connections:', err)
      close()
      reject(err)
    })
    dproxyServer.listen(sshTunnelLocalPort, sshTunnelLocalHost, () => {
      log.log(`SOCKS server listening on ${sshTunnelLocalHost}:${sshTunnelLocalPort}`)
      resolve({ close })
    }).useAuth(socks.auth.None())

    // close socks proxy when ssh connection is closed.
    conn.on('close', handleClose)
  })
}

/**
 * Remote dynamic forwarding, the `ssh -R 1080` form.
 *
 * The remote sshd opens the listening socket and hands every connection back to
 * us over a forwarded-tcpip channel; we speak SOCKS5 on that channel and dial
 * each requested destination from *this* machine. That last part is the whole
 * point of the mode and matches ssh(1): with `-R port` and no destination,
 * "ssh will act as a SOCKS 4/5 proxy and forward connections to the destinations
 * requested by the remote SOCKS client" -- the connection is made from the local
 * machine, so traffic leaves through our network, not the server's.
 */
function remoteDynamicForward ({
  conn,
  sshTunnelRemotePort,
  sshTunnelRemoteHost = '127.0.0.1'
}) {
  const socks = require('socksv5-server')
  return new Promise((resolve, reject) => {
    const result = `socks:remote:${sshTunnelRemoteHost}:${sshTunnelRemotePort}`
    const channels = new Set()

    // One server instance serves every forwarded channel: it only carries the
    // auth handlers, the handshake state lives in the parser created per stream.
    const socksServer = socks.createServer((reqInfo, accept, deny) => {
      const target = require('net').connect(reqInfo.dstPort, reqInfo.dstAddr)
      target.on('error', (err) => {
        log.error(`SOCKS target error for tunnel ${result}:`, err.message)
        deny()
      })
      // only tell the SOCKS client it worked once we actually have a connection
      target.once('connect', () => {
        const clientSocket = accept(true)
        if (!clientSocket) {
          target.destroy()
          return
        }
        target.on('error', (err) => {
          log.error(`SOCKS target error for tunnel ${result}:`, err.message)
          clientSocket.destroy()
        })
        clientSocket.on('error', (err) => {
          log.error(`SOCKS channel error for tunnel ${result}:`, err.message)
          target.destroy()
        })
        target.on('close', () => clientSocket.destroy())
        clientSocket.on('close', () => target.destroy())
        target.pipe(clientSocket).pipe(target)
      })
    })
    socksServer.useAuth(socks.auth.None())

    const handleTcpConnection = (info, accept) => {
      // several tunnels can share one connection, only take ours
      if (info.destPort !== sshTunnelRemotePort && info.destPort !== Number(sshTunnelRemotePort)) {
        return
      }
      const srcStream = accept()
      if (!srcStream) {
        log.error(`Failed to accept connection for tunnel ${result}`)
        return
      }
      channels.add(srcStream)
      srcStream.on('close', () => channels.delete(srcStream))
      srcStream.on('error', (err) => {
        log.error(`Channel error for tunnel ${result}:`, err.message)
      })
      // _onConnection is the only way to hand a plain stream to the server;
      // socksv5-server has no public equivalent for non-socket streams yet
      socksServer._onConnection(srcStream)
    }

    const handleClose = () => {
      log.log(`SSH connection closed for tunnel ${result}`)
      close()
    }

    const close = makeClose(() => {
      conn.removeListener('tcp connection', handleTcpConnection)
      conn.removeListener('close', handleClose)
      destroyAll(channels)
      unforwardIn(conn, sshTunnelRemoteHost, sshTunnelRemotePort, result)
    })

    conn.on('tcp connection', handleTcpConnection)

    conn.on('close', handleClose)

    conn.forwardIn(sshTunnelRemoteHost, sshTunnelRemotePort, (err) => {
      if (err) {
        log.error('Error forwarding port:', err)
        close()
        return reject(err)
      }
      log.log(`Port forwarded: ${result}`)
      resolve({ close })
    })
  })
}

exports.dynamicForward = dynamicForward
exports.forwardLocalToRemote = forwardLocalToRemote
exports.forwardRemoteToLocal = forwardRemoteToLocal
exports.remoteDynamicForward = remoteDynamicForward
