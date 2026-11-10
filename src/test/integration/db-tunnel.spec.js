/**
 * Integration tests for db-tunnel.js — the SSH-tunnel path under database
 * connections. electerm's db sessions are pure-DB-GUI plus tunneling, so this
 * path is the core differentiator and had ZERO coverage before (§6 I13).
 *
 * Uses the in-process SSH test server (lib/ssh-test-server.js, extended with
 * direct-tcpip/tcpip channels confined to 127.0.0.1) — no external sshd, no
 * real database. The "database" is a plain TCP echo server with a banner, so
 * a full round trip proves: ssh auth → direct-tcpip channel → bidirectional
 * byte piping local-client ⇄ dbHost:dbPort.
 *
 * Covers:
 *   - tunnel ready: resolves { port, close } on a random 127.0.0.1 port
 *   - data round trip through the tunnel (banner + echo)
 *   - multiple sequential + concurrent client connections
 *   - wrong password → createDbTunnel rejects (auth failure, no hang)
 *   - unreachable db target → per-connection socket is ended, no hang
 *   - close() → tunnel port stops accepting
 *   - ssh server down → createDbTunnel rejects fast (ECONNREFUSED)
 *
 * Run: npm run test-integration
 */

const { test, describe, before, after } = require('node:test')
const assert = require('assert/strict')
const net = require('net')

// db-tunnel 依赖 log → runtime-constants，其 packInfo 在非 development 下
// 指向 src/app/package.json（打包期才生成）。测试进程必须走 dev 分支读
// 仓库根 package.json —— 必须在 require db-tunnel 之前设置。
process.env.NODE_ENV = process.env.NODE_ENV || 'development'

const { createDbTunnel } = require('../../app/lib/db-tunnel')
const {
  startTestSshServer,
  stopTestSshServer,
  TEST_USERNAME,
  TEST_PASSWORD,
  TEST_PORT
} = require('./lib/ssh-test-server')

const BANNER = 'ELECTERM-DB-ECHO v1\n'

// Fake database: echo server. Every received chunk comes back prefixed with
// the banner so we can prove the bytes really traversed ssh → db → ssh.
function startFakeDb () {
  return new Promise(resolve => {
    const conns = new Set()
    const server = net.createServer(sock => {
      conns.add(sock)
      sock.on('close', () => conns.delete(sock))
      sock.write(BANNER)
      sock.on('data', d => sock.write(`db-echo:${d.toString()}`))
    })
    server.on('error', e => { throw e })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, conns })
    })
  })
}

// Raw client against the tunnel's local port, with one-shot helpers.
function tunnelConnect (port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1')
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new Error('tunnel connect/read timeout'))
    }, 8000)
    const fail = e => {
      clearTimeout(timer)
      sock.destroy()
      reject(e)
    }
    sock.on('error', fail)
    sock.once('data', first => {
      if (!first.toString().startsWith(BANNER)) {
        return fail(new Error(`unexpected banner: ${first.toString().slice(0, 40)}`))
      }
      resolve({
        write: s => new Promise(resolve => sock.write(s, resolve)),
        read: () => new Promise((resolve, reject) => {
          const t2 = setTimeout(() => reject(new Error('echo read timeout')), 8000)
          sock.once('data', d => {
            clearTimeout(t2)
            resolve(d.toString())
          })
          sock.once('error', e => {
            clearTimeout(t2)
            reject(e)
          })
        }),
        onceClose: () => new Promise(resolve => {
          if (sock.destroyed) return resolve()
          sock.once('close', resolve)
          // forwardOut 失败路径是 sock.end()——半关后仍会触发 close
          sock.once('error', () => {})
        }),
        end: () => sock.end(),
        destroy: () => {
          clearTimeout(timer)
          sock.destroy()
        }
      })
    })
  })
}

async function waitFor (fn, what, ms = 8000) {
  const start = Date.now()
  let lastErr = null
  while (Date.now() - start < ms) {
    try {
      const ok = await fn()
      if (ok) return true
    } catch (e) {
      lastErr = e
    }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error(`waitFor(${what}) timeout${lastErr ? ': ' + lastErr.message : ''}`)
}

describe('db-tunnel integration (in-process sshd, no real db)', () => {
  let sshServer
  let fakeDb
  let dbPort

  before(async () => {
    sshServer = await startTestSshServer()
    fakeDb = await startFakeDb()
    dbPort = fakeDb.port
  })

  after(async () => {
    if (fakeDb) {
      for (const c of fakeDb.conns) c.destroy()
      fakeDb.server.close()
    }
    await stopTestSshServer(sshServer)
  })

  test('tunnel ready: resolves { port, close } on a random 127.0.0.1 port', async () => {
    const t = await createDbTunnel(
      { host: '127.0.0.1', port: TEST_PORT, username: TEST_USERNAME, password: TEST_PASSWORD },
      '127.0.0.1',
      dbPort
    )
    assert.ok(Number.isInteger(t.port) && t.port > 0, 'port looks real')
    assert.equal(typeof t.close, 'function')
    t.close()
  })

  test('data round trip: banner then echo, bytes traverse ssh ⇄ db', async () => {
    const t = await createDbTunnel(
      { host: '127.0.0.1', port: TEST_PORT, username: TEST_USERNAME, password: TEST_PASSWORD },
      '127.0.0.1',
      dbPort
    )
    try {
      const c = await tunnelConnect(t.port)
      try {
        await c.write('ping-1')
        const back = await c.read()
        assert.ok(back.startsWith('db-echo:ping-1'), `got echo, got: ${back.slice(0, 50)}`)
      } finally {
        c.end()
      }
    } finally {
      t.close()
    }
  })

  test('multiple sequential connections reuse the same tunnel', async () => {
    const t = await createDbTunnel(
      { host: '127.0.0.1', port: TEST_PORT, username: TEST_USERNAME, password: TEST_PASSWORD },
      '127.0.0.1',
      dbPort
    )
    try {
      for (let i = 0; i < 3; i++) {
        const c = await tunnelConnect(t.port)
        try {
          await c.write(`seq-${i}`)
          const back = await c.read()
          assert.ok(back.includes(`db-echo:seq-${i}`), `round ${i} echoed`)
        } finally {
          c.end()
        }
      }
    } finally {
      t.close()
    }
  })

  test('concurrent connections are independent (no cross-stream bleed)', async () => {
    const t = await createDbTunnel(
      { host: '127.0.0.1', port: TEST_PORT, username: TEST_USERNAME, password: TEST_PASSWORD },
      '127.0.0.1',
      dbPort
    )
    try {
      const mk = async tag => {
        const c = await tunnelConnect(t.port)
        await c.write(`con-${tag}`)
        const back = await c.read()
        c.end()
        return back
      }
      const [a, b] = await Promise.all([mk('a'), mk('b')])
      assert.ok(a.includes('db-echo:con-a'), 'stream a got its own echo')
      assert.ok(b.includes('db-echo:con-b'), 'stream b got its own echo')
    } finally {
      t.close()
    }
  })

  test('wrong password: createDbTunnel rejects (no 10s hang)', async () => {
    const start = Date.now()
    await assert.rejects(
      () => createDbTunnel(
        { host: '127.0.0.1', port: TEST_PORT, username: TEST_USERNAME, password: 'wrong-pass' },
        '127.0.0.1',
        dbPort
      ),
      /All configured authentication methods failed|authentication/i
    )
    assert.ok(Date.now() - start < 10000, 'rejects faster than ready timeout')
  })

  test('unreachable db target: per-connection socket is ended, tunnel itself stays ready', async () => {
    const t = await createDbTunnel(
      { host: '127.0.0.1', port: TEST_PORT, username: TEST_USERNAME, password: TEST_PASSWORD },
      '127.0.0.1',
      1 // port 1 on loopback: nothing listens, forwardOut connect must fail
    )
    try {
      // 服务端 forwardOut err → sock.end()：客户端不应等到 banner（没有数据），
      // 而是在超时内收到关闭。裸 socket 等 close，别走等 banner 的 helper。
      const closed = await new Promise((resolve, reject) => {
        const s = net.connect(t.port, '127.0.0.1')
        const timer = setTimeout(() => {
          s.destroy()
          reject(new Error('socket not closed within 8s after forwardOut failure'))
        }, 8000)
        s.once('close', () => {
          clearTimeout(timer)
          resolve(true)
        })
        s.once('error', () => {}) // ECONNRESET 可接受，close 会跟上来
      })
      assert.ok(closed, 'client socket closed')
    } finally {
      t.close()
    }
  })

  test('close(): tunnel port stops accepting new connections', async () => {
    const t = await createDbTunnel(
      { host: '127.0.0.1', port: TEST_PORT, username: TEST_USERNAME, password: TEST_PASSWORD },
      '127.0.0.1',
      dbPort
    )
    const port = t.port
    t.close()
    await waitFor(async () => {
      await new Promise((resolve, reject) => {
        const s = net.connect(port, '127.0.0.1')
        s.once('connect', () => {
          s.destroy()
          reject(new Error('still accepting'))
        })
        s.once('error', resolve)
      })
      return true
    }, 'port closed', 8000)
  })

  test('ssh server unreachable: rejects fast (ECONNREFUSED), no hang', async () => {
    await assert.rejects(
      () => createDbTunnel(
        { host: '127.0.0.1', port: 1, username: TEST_USERNAME, password: TEST_PASSWORD },
        '127.0.0.1',
        dbPort
      ),
      /ECONNREFUSED|connect/i
    )
  })
})
