const { describe, it, before } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const net = require('node:net')

// ssh-tunnel.js logs through electron-log; a silent stand-in keeps this test
// free of electron.
const logPath = require.resolve('../../app/common/log')
require.cache[logPath] = {
  id: logPath,
  filename: logPath,
  loaded: true,
  exports: { log () {}, info () {}, warn () {}, error () {}, debug () {} }
}

let tunnel

before(() => {
  tunnel = require('../../app/server/ssh-tunnel')
})

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function freePort () {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

// the port a tunnel held has to be bindable again once close() ran - that is
// what "stopped" means for a local listener
function assertPortFree (port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', (err) => {
      reject(new Error(`port ${port} still in use: ${err.code || err.message}`))
    })
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()))
  })
}

function listeningServer (port) {
  return new Promise((resolve) => {
    const server = net.createServer((s) => s.on('data', (d) => s.write(d)))
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

/**
 * A stand-in for an ssh2 connection: the four entry points a tunnel uses, with
 * every call recorded so the close path can be checked.
 */
function fakeConn () {
  const conn = new EventEmitter()
  conn.calls = { forwardIn: [], forwardOut: [], unforwardIn: [] }
  conn.forwardIn = (host, port, cb) => {
    conn.calls.forwardIn.push([host, port])
    setImmediate(() => cb())
  }
  conn.unforwardIn = (host, port, cb) => {
    conn.calls.unforwardIn.push([host, port])
    setImmediate(() => cb())
  }
  conn.forwardOut = (srcHost, srcPort, dstHost, dstPort, cb) => {
    conn.calls.forwardOut.push([dstHost, dstPort])
    setImmediate(() => cb(null, new PassThrough()))
  }
  return conn
}

function connectClient (port) {
  return new Promise((resolve, reject) => {
    const client = net.connect(port, '127.0.0.1')
    client.once('connect', () => resolve(client))
    client.once('error', reject)
  })
}

describe('tunnel close handles', () => {
  it('forwardLocalToRemote: close frees the local port and drops the conn listener', async () => {
    const port = await freePort()
    const conn = fakeConn()
    const handle = await tunnel.forwardLocalToRemote({
      conn,
      sshTunnelLocalPort: port,
      sshTunnelRemotePort: 22
    })
    assert.equal(typeof handle.close, 'function')
    const client = await connectClient(port)
    await wait(30)

    handle.close()
    await wait(30)

    assert.equal(client.destroyed, true)
    assert.equal(conn.listenerCount('close'), 0)
    await assertPortFree(port)
    // a second stop (the connection closing right after) must not throw
    handle.close()
  })

  it('forwardLocalToRemote: the ssh connection closing releases the port too', async () => {
    const port = await freePort()
    const conn = fakeConn()
    await tunnel.forwardLocalToRemote({
      conn,
      sshTunnelLocalPort: port,
      sshTunnelRemotePort: 22
    })
    conn.emit('close')
    await wait(30)
    await assertPortFree(port)
  })

  it('forwardRemoteToLocal: close cancels the remote bind and kills both sides', async () => {
    const localPort = await freePort()
    const echo = await listeningServer(localPort)
    const conn = fakeConn()
    const handle = await tunnel.forwardRemoteToLocal({
      conn,
      sshTunnelRemotePort: 8080,
      sshTunnelLocalPort: localPort
    })

    const channel = new PassThrough()
    conn.emit('tcp connection', { destIP: '127.0.0.1', destPort: 8080 }, () => channel)
    await wait(30)

    handle.close()
    await wait(30)

    assert.equal(channel.destroyed, true)
    assert.deepEqual(conn.calls.unforwardIn, [['127.0.0.1', 8080]])
    assert.equal(conn.listenerCount('tcp connection'), 0)
    assert.equal(conn.listenerCount('close'), 0)
    // an already detached channel is not served any more
    const late = new PassThrough()
    conn.emit('tcp connection', { destPort: 8080 }, () => late)
    await wait(20)
    assert.equal(late.destroyed, false)
    echo.close()
    handle.close()
  })

  it('forwardRemoteToLocal: a dead connection cannot be unforwarded, close still works', async () => {
    const localPort = await freePort()
    const conn = fakeConn()
    conn.unforwardIn = () => {
      // ssh2 throws 'Not connected' once the socket is gone
      throw new Error('Not connected')
    }
    const handle = await tunnel.forwardRemoteToLocal({
      conn,
      sshTunnelRemotePort: 8081,
      sshTunnelLocalPort: localPort
    })
    assert.doesNotThrow(() => handle.close())
    assert.equal(conn.listenerCount('tcp connection'), 0)
  })

  it('dynamicForward: close frees the SOCKS port', async () => {
    const port = await freePort()
    const conn = fakeConn()
    const handle = await tunnel.dynamicForward({ conn, sshTunnelLocalPort: port })
    assert.equal(typeof handle.close, 'function')

    handle.close()
    await wait(30)
    await assertPortFree(port)
    assert.equal(conn.listenerCount('close'), 0)
    handle.close()
  })

  it('remoteDynamicForward: close cancels the remote bind and stops serving channels', async () => {
    const conn = fakeConn()
    const handle = await tunnel.remoteDynamicForward({
      conn,
      sshTunnelRemotePort: 1090
    })

    const channel = new PassThrough()
    conn.emit('tcp connection', { destPort: 1090 }, () => channel)
    await wait(20)

    handle.close()
    await wait(20)

    assert.equal(channel.destroyed, true)
    assert.deepEqual(conn.calls.unforwardIn, [['127.0.0.1', 1090]])
    assert.equal(conn.listenerCount('tcp connection'), 0)
    assert.equal(conn.listenerCount('close'), 0)

    const late = new PassThrough()
    conn.emit('tcp connection', { destPort: 1090 }, () => late)
    await wait(20)
    assert.equal(late.destroyed, false)
    handle.close()
  })

  it('a failed tunnel leaves no listener and no port behind', async () => {
    const port = await freePort()
    const conn = new EventEmitter()
    conn.forwardIn = (host, port_, cb) => cb(new Error('Unable to bind'))
    await assert.rejects(
      tunnel.forwardRemoteToLocal({
        conn,
        sshTunnelRemotePort: 8082,
        sshTunnelLocalPort: port
      }),
      /Unable to bind/
    )
    assert.equal(conn.listenerCount('tcp connection'), 0)
    assert.equal(conn.listenerCount('close'), 0)
  })
})
