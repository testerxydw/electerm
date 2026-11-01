process.env.NODE_ENV = 'development'

const { describe, test, before, after, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('net')
const { once } = require('node:events')
const { Server, utils } = require('@electerm/ssh2')
const { session } = require('../../../src/app/server/session-ssh')

const USERNAME = 'tester'
const PASSWORD = 'electerm-test'

const HOST_KEY = utils.generateKeyPairSync('ed25519', {
  comment: 'electerm-test-host'
})

function makeTmpDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-tunnel-op-'))
}

function setEnvVar (name, value) {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

function freePort () {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

// the local listener *is* the tunnel: while it answers, forward requests to the
// server would be served; while it is gone, nothing binds that port
function assertPortOpen (port) {
  return new Promise((resolve, reject) => {
    const client = net.connect(port, '127.0.0.1')
    client.once('connect', () => {
      client.destroy()
      resolve()
    })
    client.once('error', () => reject(new Error(`nothing listens on ${port}`)))
  })
}

function assertPortFree (port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', (err) => reject(new Error(`port ${port} still bound: ${err.code}`)))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()))
  })
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function startServer () {
  const clients = new Set()
  const server = new Server({
    hostKeys: [HOST_KEY.private]
  }, (client) => {
    clients.add(client)
    client.on('close', () => clients.delete(client))
    client.on('authentication', (ctx) => {
      if (ctx.method === 'none') {
        return ctx.reject(['password'])
      }
      if (ctx.method === 'password' && ctx.username === USERNAME && ctx.password === PASSWORD) {
        return ctx.accept()
      }
      return ctx.reject(['password'])
    })
    client.on('ready', () => {
      client.on('session', (accept) => {
        const sshSession = accept()
        // env/pty requests only get a reply when the client asked for one, and
        // electerm's shell sends them without - calling a missing accept()
        // throws and the channel dies before the shell opens
        sshSession.on('env', (accept) => accept && accept())
        sshSession.on('pty', (accept) => accept && accept())
        sshSession.on('shell', (accept) => {
          const stream = accept()
          stream.write('electerm ready\n')
        })
      })
    })
  })
  server.listen(0, '127.0.0.1')
  return once(server, 'listening').then(() => ({
    port: server.address().port,
    async close () {
      for (const client of clients) {
        client.end()
      }
      await new Promise((resolve) => server.close(resolve))
    }
  }))
}

/**
 * Records what the session pushes to the tab and answers what it asks: a host
 * key trust confirm and, if the bookmark has no password, the password prompt.
 * Same shape as session-ssh.spec.js uses.
 */
function createWs (promptResponder = () => [PASSWORD]) {
  const prompts = []
  let pendingOptions
  return {
    prompts,
    sent: [],
    s (payload) {
      if (payload && payload.action) {
        this.sent.push(payload)
      }
      if (payload && payload.action === 'session-interactive') {
        pendingOptions = payload.options
        if (payload.options?.mode !== 'confirm') {
          prompts.push(payload.options)
        }
      }
    },
    once (handler) {
      const options = pendingOptions
      const results = options?.mode === 'confirm'
        ? ['trust']
        : promptResponder(options, prompts)
      queueMicrotask(() => handler({ results }))
      return () => {}
    },
    close () {}
  }
}

function sentOf (ws, action) {
  return ws.sent.filter(p => p.action === action)
}

function lastRows (ws) {
  const list = sentOf(ws, 'ssh-tunnel-result')
  assert.ok(list.length, 'no ssh-tunnel-result was pushed')
  return list[list.length - 1].update.sshTunnelResults
}

function localForward (port) {
  return {
    id: 't1',
    name: 'dev-db',
    sshTunnel: 'forwardLocalToRemote',
    sshTunnelLocalHost: '127.0.0.1',
    sshTunnelLocalPort: port,
    sshTunnelRemoteHost: '127.0.0.1',
    sshTunnelRemotePort: 5432
  }
}

describe('session ssh tunnel runtime', () => {
  let tmpDir
  let oldEnv
  let server
  let term

  before(() => {
    tmpDir = makeTmpDir()
    oldEnv = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK
    }
    setEnvVar('HOME', tmpDir)
    setEnvVar('USERPROFILE', tmpDir)
    setEnvVar('SSH_AUTH_SOCK', undefined)
  })

  after(() => {
    setEnvVar('HOME', oldEnv.HOME)
    setEnvVar('USERPROFILE', oldEnv.USERPROFILE)
    setEnvVar('SSH_AUTH_SOCK', oldEnv.SSH_AUTH_SOCK)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    server = await startServer()
  })

  afterEach(async () => {
    term && term.kill()
    term = undefined
    await server.close()
  })

  async function connect (sshTunnels) {
    const ws = createWs()
    term = await session({
      host: '127.0.0.1',
      port: server.port,
      username: USERNAME,
      password: PASSWORD,
      useSshAgent: false,
      readyTimeout: 5000,
      srcTabId: 'tab-tunnel',
      sshTunnels
    }, ws)
    return { ws, port: server.port }
  }

  test('a tunnel started at connect is listed with its id and holds its port', async () => {
    const port = await freePort()
    const { ws } = await connect([localForward(port)])

    const rows = lastRows(ws)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 't1')
    assert.equal(rows[0].sshTunnel.sshTunnelLocalPort, port)
    assert.equal(rows[0].error, undefined)
    assert.equal(rows[0].stopped, undefined)
    await assertPortOpen(port)
  })

  test('stop releases the port, start takes it back, and both are reported', async () => {
    const port = await freePort()
    const { ws } = await connect([localForward(port)])

    const afterStop = await term.tunnelOp('stop', 't1')
    await wait(30)
    await assertPortFree(port)
    assert.equal(afterStop[0].stopped, true)
    assert.equal(afterStop[0].error, undefined)
    // the tab is told the same thing the caller gets back
    assert.equal(lastRows(ws)[0].stopped, true)

    const afterStart = await term.tunnelOp('start', 't1')
    await assertPortOpen(port)
    assert.equal(afterStart[0].stopped, undefined)
    assert.equal(afterStart[0].error, undefined)
  })

  test('starting what already runs does not fail on the port it already holds', async () => {
    const port = await freePort()
    await connect([localForward(port)])

    const rows = await term.tunnelOp('start', 't1')
    assert.equal(rows[0].error, undefined)
    assert.equal(rows[0].stopped, undefined)
    await assertPortOpen(port)
  })

  test('an op on an unknown id or of an unknown kind is refused', async () => {
    const port = await freePort()
    await connect([localForward(port)])

    await assert.rejects(term.tunnelOp('stop', 'nope'), /not running/)
    await assert.rejects(term.tunnelOp('start', 'nope'), /not configured/)
    await assert.rejects(term.tunnelOp('restart', 't1'), /unknown tunnel op/)
    // a refused op must not disturb the tunnel that is up
    await assertPortOpen(port)
  })

  test('only tunnels this session was configured with can be started', async () => {
    const port = await freePort()
    await connect([localForward(port)])

    // the id space is ours, the spec space comes from the bookmark: a message
    // from a tab must not be able to open a forward nobody asked for
    await assert.rejects(term.tunnelOp('start', 't2'), /not configured/)
  })

  test('a tunnel without a listen port is registered but never started', async () => {
    const { ws } = await connect([{
      id: 'nop',
      sshTunnel: 'dynamicForward',
      sshTunnelLocalHost: '127.0.0.1'
    }])

    assert.deepEqual(lastRows(ws), [])
    await assert.rejects(term.tunnelOp('start', 'nop'), /no listen port/)
  })

  test('an entry with no id is addressed by its position', async () => {
    const port = await freePort()
    const spec = localForward(port)
    delete spec.id
    await connect([spec])

    const rows = await term.tunnelOp('stop', 'tunnel-0')
    assert.equal(rows[0].id, 'tunnel-0')
    assert.equal(rows[0].stopped, true)
    await wait(30)
    await assertPortFree(port)
  })

  test('a tunnel the server refuses is reported and does not stop the others', async () => {
    const port = await freePort()
    const bad = {
      id: 'bad',
      // a remote forward the test server will not bind: port 0 with a host the
      // server is not listening on is refused by ssh2 itself
      sshTunnel: 'forwardRemoteToLocal',
      sshTunnelRemoteHost: 'no.such.host.invalid',
      sshTunnelRemotePort: 65535,
      sshTunnelLocalHost: '127.0.0.1',
      sshTunnelLocalPort: port
    }
    const { ws } = await connect([localForward(await freePort()), bad])

    const rows = lastRows(ws)
    assert.equal(rows.length, 2)
    assert.equal(rows[1].id, 'bad')
    assert.match(rows[1].error, /Unable to bind|invalid|refused|denied/i)
    assert.equal(rows[0].error, undefined)
  })

  test('killing the session releases the tunnel port', async () => {
    const port = await freePort()
    await connect([localForward(port)])
    await assertPortOpen(port)

    term.kill()
    term = undefined
    await wait(50)
    await assertPortFree(port)
  })
})
