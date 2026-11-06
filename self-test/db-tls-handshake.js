#!/usr/bin/env node
/**
 * N1 · TLS 证书校验档位 —— 真握手验收（本机无 mysqld/redis-server/docker）
 *
 * 为什么要这一份（单测替代不了）：
 * db-tls.spec.js / db-ssl-contract.spec.js 钉的是"选项怎么拼、签名怎么变"，
 * 而 N1 的验收线写的是**连接结果**：
 *   ① 自签 + 指定正确 CA → 连上
 *   ② 自签 + 校验开启不给 CA → 失败并报证书错误（关键回归）
 * 这两条只有真 TLS 握手能证。②的两个反例形态在纯单测里看不出来：
 *   - "档位没摊进驱动选项" → 勾选了却仍明文连上
 *   - "CA 读不到就降级成不校验" → 连上了，但用户选的 CA 根本没参与判定
 *
 * 三层证据（各自能证什么、不能证什么，写在每层的注释里）：
 *   L1 选项语义层：把**发布源码里的** sslOptions/tlsOptions 抠出来在 vm 里跑，
 *      拿到真实选项对象，再按各驱动调用 tls.connect 的方式喂给真 TLS 服务端。
 *      这一层能证"这套选项到底连不连得上"，不能证"驱动有没有把它摊进建连"
 *      （后者由 db-ssl-contract.spec.js 的调用点契约钉住）。
 *      mysql2 与 node 系（pg/ioredis）在"验不验证书身份"上口径不同，
 *      所以按 mysql2 源码复刻它的 servername / checkServerIdentity 传参，
 *      并跑一组差分：去掉 verifyIdentity 就放行 → 证明拦下它的是这一位。
 *   L2 驱动端到端：redis 是**首字节就是 TLS** 的协议（不像 mysql/pg 要先走
 *      STARTTLS 升级），所以能起一个玩具 RESP over TLS 服务端，直接调真实的
 *      testRedisConnection()，把①②跑在真实 ioredis 路径上。
 *   L3 池键层：档位与 CA 内容真的进签名（切档位/换 CA = 换新池）。
 *
 * MySQL/PG 的 STARTTLS 升级路径没有做真驱动端到端：假库必须把 SSLRequest 之后
 * 的字节原样交给 TLS 引擎，而这两个包在 loopback 上会同一次 read 到达
 * （实测 leftover = 1568 字节、以 16 03 01 开头），node 的 TLSSocket wrap 会
 * 接管 handle、流内缓冲随之丢失 —— 自己实现的垫片做不到干净分流。
 * 该风险由 L1（同形状选项 + mysql2 复刻传参）+ 调用点契约单测覆盖。
 *
 * 用法：
 *   node self-test/db-tls-handshake.js            # 全矩阵
 *   node self-test/db-tls-handshake.js --keep     # 保留证书临时目录并打印路径
 *
 * 依赖：/usr/bin/openssl（生成自签证书）、node 内置 tls/net、仓库里的 ioredis。
 * 夹具全部落在 os.tmpdir()（AGENTS.md：一次性目录不进仓库、结束直删不进回收站）。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const tls = require('node:tls')
const vm = require('node:vm')
const { execFileSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const DB_CLIENT = path.join(ROOT, 'src/app/lib/db-client')
const read = p => fs.readFileSync(p, 'utf8')

const dbTls = require(path.join(DB_CLIENT, 'db-tls.js'))

// 从发布源码里抠出 `function X (conn) { ... }` 并在 vm 里执行（与
// db-ssl-contract.spec.js 同一手法）：跑的是将要发布的那份实现，不是抄一份。
function loadFn (src, name) {
  const m = src.match(new RegExp('^function ' + name + ' \\(conn\\) \\{[\\s\\S]*?\\n\\}', 'm'))
  if (!m) throw new Error('function ' + name + '(conn) not found in source')
  return vm.runInNewContext('(' + m[0] + ')', {
    resolveTlsProfile: dbTls.resolveTlsProfile,
    tlsSigTag: dbTls.tlsSigTag,
    Error
  })
}

const SSL_OPTIONS = {
  mysql: loadFn(read(path.join(DB_CLIENT, 'mysql.js')), 'sslOptions'),
  postgres: loadFn(read(path.join(DB_CLIENT, 'postgres.js')), 'sslOptions'),
  redis: loadFn(read(path.join(DB_CLIENT, 'redis.js')), 'tlsOptions')
}

const results = []
const check = (name, ok, extra) => {
  results.push({ name, ok: !!ok, extra })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra === undefined ? '' : ' :: ' + String(extra).slice(0, 260)}`)
}

const isCertError = msg =>
  /certificate|self-signed|unable to verify|altname|issuer|verify/i.test(String(msg)) &&
  !/ECONNREFUSED|ETIMEDOUT|timeout|socket hang up/i.test(String(msg))

// ---- 自签证书 ----
// good : SAN = IP:127.0.0.1 + DNS:localhost（正常服务端）
// other: 主体一样、私钥不一样（拿它当 CA 必须验链失败）
// wrong: SAN 只有 DNS:db.electerm-n1.invalid（链能验通，但名字对不上 → 只有"验名"才拦得住）
function genCert (dir, base, san) {
  const key = path.join(dir, base + '-key.pem')
  const cert = path.join(dir, base + '-cert.pem')
  execFileSync('/usr/bin/openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '2',
    '-subj', '/CN=electerm-n1-test',
    '-addext', 'subjectAltName=' + san
  ], { stdio: ['ignore', 'ignore', 'ignore'] })
  return { key, cert }
}

// ---- 玩具 RESP ----
// 够 ioredis 的 connect + ping + readyCheck(info) 跑通即可；未知命令一律 +OK。
function attachResp (stream) {
  let buf = Buffer.alloc(0)
  const reply = args => {
    const name = String(args[0] || '').toUpperCase()
    if (name === 'PING') return stream.write('+PONG\r\n')
    if (name === 'INFO') {
      const text = '# Server\nredis_version:7.0.0\n# Replication\nrole:master\ncluster_enabled:0\n# Clients\nloading:0\n# Memory\nmaxmemory:0\nmaxmemory_human:0B\nmaxmemory_policy:noeviction\n'
      return stream.write('$' + text.length + '\r\n' + text + '\r\n')
    }
    if (name === 'QUIT') {
      stream.write('+OK\r\n')
      return stream.end()
    }
    stream.write('+OK\r\n')
  }
  const parse = () => {
    for (;;) {
      if (!buf.length) return
      if (buf[0] !== 0x2a) {
        // inline 命令（"PING\r\n"）
        const eol = buf.indexOf('\r\n')
        if (eol < 0) return
        reply(buf.subarray(0, eol).toString().split(' '))
        buf = buf.subarray(eol + 2)
        continue
      }
      const eol = buf.indexOf('\r\n', 1)
      if (eol < 0) return
      const n = Number(buf.subarray(1, eol).toString())
      let pos = eol + 2
      const args = []
      for (let i = 0; i < n; i++) {
        if (buf[pos] !== 0x24) return
        const le = buf.indexOf('\r\n', pos + 1)
        if (le < 0) return
        const len = Number(buf.subarray(pos + 1, le).toString())
        if (buf.length < le + 2 + len + 2) return
        args.push(buf.subarray(le + 2, le + 2 + len).toString())
        pos = le + 2 + len + 2
      }
      buf = buf.subarray(pos)
      reply(args)
    }
  }
  stream.on('data', chunk => {
    buf = Buffer.concat([buf, chunk])
    parse()
  })
  stream.on('error', () => {})
}

function listen (server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      close: () => new Promise(resolve => server.close(() => resolve()))
    }))
  })
}

// ---- L1：把真实选项对象喂给真 TLS 服务端 ----
// mysqlify=true 时按 mysql2 源码复刻传参（IP 主机名不给 servername、
// 未开启 verifyIdentity 就把 checkServerIdentity 换成空函数）。
function handshake (opts, host, port, mysqlify) {
  return new Promise(resolve => {
    const ssl = { ...opts }
    const base = { port, host, timeout: 6000 }
    if (mysqlify) {
      const servername = net.isIP(host) ? undefined : host
      const verifyIdentity = !!ssl.verifyIdentity
      delete ssl.verifyIdentity
      base.servername = servername
      base.checkServerIdentity = verifyIdentity ? tls.checkServerIdentity : () => undefined
    }
    const s = tls.connect({ ...base, ...ssl }, () => {
      const cert = s.getPeerCertificate()
      s.destroy()
      resolve({ ok: true, authorized: s.authorized, fingerprint: cert && cert.fingerprint256 })
    })
    s.on('error', e => {
      s.destroy()
      resolve({ ok: false, code: e.code, message: (e.code || '') + ' ' + e.message })
    })
  })
}

async function main () {
  const keep = process.argv.includes('--keep')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-n1-tls-'))
  let good = null
  let wrong = null
  let plain = null
  const redisAdapter = require(path.join(DB_CLIENT, 'redis.js'))
  try {
    const cGood = genCert(dir, 'good', 'IP:127.0.0.1,DNS:localhost')
    const cOther = genCert(dir, 'other', 'IP:127.0.0.1,DNS:localhost')
    const cWrong = genCert(dir, 'wrong', 'DNS:db.electerm-n1.invalid')
    const keyOf = f => fs.readFileSync(f)
    good = await listen(tls.createServer({ key: keyOf(cGood.key), cert: keyOf(cGood.cert) }, attachResp))
    wrong = await listen(tls.createServer({ key: keyOf(cWrong.key), cert: keyOf(cWrong.cert) }, attachResp))
    plain = await listen(net.createServer(sock => attachResp(sock)))
    console.log('tls(good)  127.0.0.1:' + good.port + ' SAN=IP:127.0.0.1,DNS:localhost')
    console.log('tls(wrong) 127.0.0.1:' + wrong.port + ' SAN=DNS:db.electerm-n1.invalid')
    console.log('plain      127.0.0.1:' + plain.port + ' (RESP, no TLS)')

    // ================= L1 选项语义层 =================
    // 对 mysql / postgres 两个形状各跑一遍（两者都返回 { ssl }，只是 mysql 多一个
    // verifyIdentity 键）——同一档位在不同引擎下必须是同一套连接结果。
    for (const engine of ['mysql', 'postgres']) {
      const build = SSL_OPTIONS[engine]
      const mysqlify = engine === 'mysql'
      const off = build({ dbSsl: false })
      check(`L1-${engine} 关 TLS 时不产生任何 ssl 键（旧书签行为不变）`,
        JSON.stringify(off) === '{}', off)

      const none = build({ dbSsl: true, dbSslVerify: 'none' })
      const rNone = await handshake(none.ssl, '127.0.0.1', good.port, mysqlify)
      check(`L1-${engine} 不校验档位：自签证书握手成功且 rejectUnauthorized=false`,
        rNone.ok && none.ssl.rejectUnauthorized === false, rNone)

      const sys = build({ dbSsl: true, dbSslVerify: 'system' })
      const rSys = await handshake(sys.ssl, '127.0.0.1', good.port, mysqlify)
      check(`L1-${engine} 系统根档位：自签证书必须失败（验收②）`,
        !rSys.ok && isCertError(rSys.message), rSys)
      check(`L1-${engine} 系统根档位：不传 ca（确实走系统根库）`,
        sys.ssl.rejectUnauthorized === true && sys.ssl.ca === undefined, sys.ssl)

      const ca = build({ dbSsl: true, dbSslVerify: 'ca', dbSslCa: cGood.cert })
      const rCa = await handshake(ca.ssl, '127.0.0.1', good.port, mysqlify)
      check(`L1-${engine} 指定正确 CA：握手成功（验收①）`, rCa.ok, rCa)
      check(`L1-${engine} CA 档把文件内容原样交给驱动（Buffer，不是路径字符串）`,
        Buffer.isBuffer(ca.ssl.ca), typeof (ca.ssl && ca.ssl.ca))

      const badCa = build({ dbSsl: true, dbSslVerify: 'ca', dbSslCa: cOther.cert })
      const rBad = await handshake(badCa.ssl, '127.0.0.1', good.port, mysqlify)
      check(`L1-${engine} 指定错误 CA：失败且是证书错误`,
        !rBad.ok && isCertError(rBad.message), rBad)

      // 差分证据：同一份"链能验通但名字不符"的现场，只验链会放行、验名会拦住。
      // mysql2 需要 ssl.verifyIdentity 才会验名（它把 checkServerIdentity 传成
      // 空函数），node 系（pg）默认就验 —— 这一位不摊，MySQL 就是三引擎里唯一
      // "合法 CA 签发的他人证书也能连"的引擎。
      const rName = await handshake(ca.ssl, 'localhost', wrong.port, mysqlify)
      check(`L1-${engine} 严格档位还要验证书身份（域名 + 名字不符 → 失败）`,
        !rName.ok && isCertError(rName.message), rName)
      const rNameOn = await handshake(ca.ssl, 'localhost', good.port, mysqlify)
      check(`L1-${engine} 名字匹配时不拦（证明上一条不是严格档位一律连不上）`,
        rNameOn.ok, rNameOn)
    }

    // mysql2 独有：不带 verifyIdentity 的旧形状在同一条链路上会放行（差分基线）
    const legacyShape = { rejectUnauthorized: true, ca: keyOf(cWrong.cert) }
    const rLegacy = await handshake(legacyShape, 'localhost', wrong.port, true)
    check('L1-mysql 差分基线：旧形状（无 verifyIdentity）确实会放行名字不符的证书',
      rLegacy.ok, rLegacy)

    // CA 选了但读不到：必须在建连点抛错，而不是降级成"不校验"
    let throwEmpty = null
    try {
      SSL_OPTIONS.mysql({ dbSsl: true, dbSslVerify: 'ca', dbSslCa: '' })
    } catch (e) {
      throwEmpty = e
    }
    check('L1 空 CA 路径：建连前抛错且文案可诊断',
      !!throwEmpty && /CA certificate file is not selected/i.test(throwEmpty.message),
      throwEmpty && throwEmpty.message)
    let throwMissing = null
    try {
      SSL_OPTIONS.postgres({ dbSsl: true, dbSslVerify: 'ca', dbSslCa: path.join(dir, 'not-there.pem') })
    } catch (e) {
      throwMissing = e
    }
    check('L1 CA 文件读不到：抛错而不是静默不校验',
      !!throwMissing && /Cannot read CA certificate file/i.test(throwMissing.message),
      throwMissing && throwMissing.message)

    // ================= L2 驱动端到端（redis：首字节即 TLS）=================
    const pwd = 'p@ssw0rd-for-sig-check'
    const conn = extra => ({
      dbHost: '127.0.0.1',
      dbPort: good.port,
      dbPassword: pwd,
      dbSsl: true,
      ...extra
    })
    const offRes = await redisAdapter.testRedisConnection({
      dbHost: '127.0.0.1', dbPort: plain.port, dbPassword: pwd, dbSsl: false
    })
    check('L2-redis 关 TLS：明文连上（旧书签行为不变）', offRes === 'redis PONG', offRes)

    const noneRes = await redisAdapter.testRedisConnection(conn({ dbSslVerify: 'none' }))
    check('L2-redis 不校验档位：自签证书连上', noneRes === 'redis PONG', noneRes)

    const legacyRes = await redisAdapter.testRedisConnection({
      dbHost: '127.0.0.1', dbPort: good.port, dbPassword: pwd, dbSsl: true
    })
    check('L2-redis 旧书签（无档位字段）按不校验解释、仍能连上',
      legacyRes === 'redis PONG', legacyRes)

    let sysRes = null
    let sysErr = null
    try {
      sysRes = await redisAdapter.testRedisConnection(conn({ dbSslVerify: 'system' }))
    } catch (e) {
      sysErr = e
    }
    check('L2-redis 系统根 + 自签：真实 ioredis 路径连不上（验收②驱动级）',
      !sysRes && !!sysErr && isCertError((sysErr.code || '') + ' ' + sysErr.message),
      sysErr && ((sysErr.code || '') + ' ' + sysErr.message))
    check('L2-redis 失败信息不回显密码',
      !!sysErr && !String(sysErr.message).includes(pwd), sysErr && sysErr.message)

    const caRes = await redisAdapter.testRedisConnection(
      conn({ dbSslVerify: 'ca', dbSslCa: cGood.cert })
    )
    check('L2-redis 指定正确 CA：真实 ioredis 路径连上（验收①驱动级）',
      caRes === 'redis PONG', caRes)

    let badRes = null
    let badErr = null
    try {
      badRes = await redisAdapter.testRedisConnection(conn({ dbSslVerify: 'ca', dbSslCa: cOther.cert }))
    } catch (e) {
      badErr = e
    }
    check('L2-redis 指定错误 CA：连不上且报证书错误',
      !badRes && !!badErr && isCertError((badErr.code || '') + ' ' + badErr.message),
      badErr && ((badErr.code || '') + ' ' + badErr.message))

    let missRes = null
    let missErr = null
    try {
      missRes = await redisAdapter.testRedisConnection(
        conn({ dbSslVerify: 'ca', dbSslCa: path.join(dir, 'not-there.pem') })
      )
    } catch (e) {
      missErr = e
    }
    check('L2-redis CA 读不到：连不上且不降级', !missRes && !!missErr,
      missErr && missErr.message)

    // ================= L3 池键层 =================
    const base = { dbHost: '127.0.0.1', dbPort: 6379 }
    const tags = {
      off: dbTls.tlsSigTag({ ...base, dbSsl: false }),
      none: dbTls.tlsSigTag({ ...base, dbSsl: true, dbSslVerify: 'none' }),
      system: dbTls.tlsSigTag({ ...base, dbSsl: true, dbSslVerify: 'system' }),
      caGood: dbTls.tlsSigTag({ ...base, dbSsl: true, dbSslVerify: 'ca', dbSslCa: cGood.cert }),
      caOther: dbTls.tlsSigTag({ ...base, dbSsl: true, dbSslVerify: 'ca', dbSslCa: cOther.cert })
    }
    check('L3 关 TLS / 三种档位 / 两份 CA = 5 条不同池键（验收④）',
      new Set(Object.values(tags)).size === 5, tags)
    check('L3 同一份 CA 重复解析签名稳定（否则池永不复用）',
      dbTls.tlsSigTag({ ...base, dbSsl: true, dbSslVerify: 'ca', dbSslCa: cGood.cert }) === tags.caGood,
      tags.caGood)
    fs.appendFileSync(cGood.cert, '\n')
    check('L3 换 CA 内容（路径不变）→ 换新池键',
      dbTls.tlsSigTag({ ...base, dbSsl: true, dbSslVerify: 'ca', dbSslCa: cGood.cert }) !== tags.caGood)
    const dump = JSON.stringify(tags)
    check('L3 池键不含密码、不含 CA 路径（会进日志与调试输出）',
      !dump.includes(pwd) && !dump.includes(dir), dump)
    check('L3 档位连上之后 redis 侧仍在同一签名下复用（不重复建 client）',
      dbTls.tlsSigTag({ ...base, dbSsl: true, dbSslVerify: 'system' }) === tags.system,
      tags.system)
  } finally {
    if (good) await good.close()
    if (wrong) await wrong.close()
    if (plain) await plain.close()
    if (keep) {
      console.log('KEEP', dir)
    } else {
      // AGENTS.md：可再生产物直删，不进回收站
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  const bad = results.filter(r => !r.ok)
  console.log('\n' + (results.length - bad.length) + '/' + results.length + ' 条通过')
  if (bad.length) console.log('FAILED:', bad.map(b => b.name).join(' | '))
  process.exit(bad.length ? 1 : 0)
}

main().catch(e => {
  console.error('ERR', e && e.stack ? e.stack : e)
  process.exit(1)
})
