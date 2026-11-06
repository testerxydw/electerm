const { describe, test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')

// B1 + N1（连接级 TLS/SSL 与证书校验档位）回归保护。
// 背景：B1 落地前 mysql 的 testMysqlConnection **完全没有** ssl 参数（勾了 SSL
// 测试连接必失败）、redis 的 createClient 没有 tls（rediss 不可用）、三处 sig()
// 不含 ssl 标记（同 host:port 切换开关后复用旧池/旧 client →"改了不生效"）。
// 这三条都不是类型错误，跑单元测试也发现不了，只有真库才暴露；本机无 mysqld/redis，
// 故用"源码契约 + 真实函数体执行"两层守护：
//   1) 函数体从源码抠出来在 vm 里跑，断言行为（改动逻辑会失败，不是字符串比对）
//   2) 建连调用点必须摊入选项函数（漏一处就是"测试通过但连不上"）
//
// N1 追加的守护是"档位口径只有一份"：适配器的选项函数现在委托 db-tls.js，
// 所以 vm 沙箱注入的是真模块的 resolveTlsProfile / tlsSigTag —— 注入这一步本身就
// 钉住了"适配器没有另写一套档位判断"。档位自身的取值、CA 读取与指纹行为由
// db-tls.spec.js 直接单测，本文件不重复。

const ROOT = path.join(__dirname, '../../..')
const CLIENT = path.join(ROOT, 'src/app/lib/db-client')
const SCHEMAS = path.join(ROOT, 'src/client/common/bookmark-schemas.js')
const FORM = path.join(ROOT, 'src/client/components/bookmark-form/config/database.js')
const LOCALES = path.join(ROOT, 'src/app/common/locales-extra.js')

// db-tls 只依赖 fs/crypto，可直接 require 后注入沙箱
const dbTls = require(path.join(CLIENT, 'db-tls'))

const read = p => fs.readFileSync(p, 'utf8')

// vm 里造的对象与宿主 realm 的原型不同，deepStrictEqual 会因原型不等而失败；
// JSON 往返把跨 realm 值拉回本 realm 再比口径（这里只关心可序列化形状）
const plain = v => JSON.parse(JSON.stringify(v))

// 抠出 `function name (…) { ... }` 的完整定义（含内部注释）并在 vm 里执行。
// 不 new Function：跑的是发布源码本身，且过 standard 的 no-new-func
// 参数表不锁定：sig/sslOptions 收 conn，withRealCause 收 (e, lastError)，
// 都在发布源码里被同样地执行
const loadFn = (src, name) => {
  const re = new RegExp('^function ' + name + ' \\([^)]*\\) \\{[\\s\\S]*?\\n\\}', 'm')
  const m = src.match(re)
  assert.ok(m, `function ${name}(...) not found in source`)
  return vm.runInNewContext('(' + m[0] + ')', {
    resolveTlsProfile: dbTls.resolveTlsProfile,
    tlsSigTag: dbTls.tlsSigTag
  })
}

// 取某个顶层函数的整个定义体（用于断言内部是否摊入选项函数）
const fnBody = (src, name) => {
  const re = new RegExp('^(?:async )?function ' + name + ' \\([^)]*\\) \\{[\\s\\S]*?\\n\\}', 'm')
  const m = src.match(re)
  assert.ok(m, `function ${name} not found in source`)
  return m[0]
}

const MYSQL = read(path.join(CLIENT, 'mysql.js'))
const PG = read(path.join(CLIENT, 'postgres.js'))
const REDIS = read(path.join(CLIENT, 'redis.js'))
const CLIENT_INDEX = read(path.join(CLIENT, 'index.js'))

const base = {
  dbHost: '127.0.0.1',
  dbPort: 3306,
  dbUser: 'root',
  dbName: 'demo'
}

// CA 测试文件放 os.tmpdir()，收尾直删（AGENTS.md：可再生产物不转回收站）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-db-ssl-'))
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

const caFile = (content) => {
  const p = path.join(tmpDir, 'ca-' + content + '.pem')
  fs.writeFileSync(p, content)
  return p
}

describe('B1/N1 sslOptions / tlsOptions 行为', () => {
  test('mysql sslOptions: 开=按档位给 ssl 键, 关=不传 ssl 键', () => {
    const sslOptions = loadFn(MYSQL, 'sslOptions')
    // 缺省档位（旧书签只有 dbSsl 布尔）= 不校验，与 B1 当时的实际行为一致
    assert.deepEqual(plain(sslOptions({ dbSsl: true })), { ssl: { rejectUnauthorized: false } })
    assert.deepEqual(
      plain(sslOptions({ dbSsl: true, dbSslVerify: 'system' })),
      { ssl: { rejectUnauthorized: true, verifyIdentity: true } },
      'system 档不得带 ca：带上 ca 会把公共证书链一起否掉'
    )
    // 关断必须是空对象（摊进配置后等于"没有 ssl 选项"），不能是 ssl:undefined
    assert.deepEqual(plain(sslOptions({ dbSsl: false })), {})
    assert.deepEqual(plain(sslOptions({})), {}, '缺省按关闭处理')
  })

  test('mysql ca 档：读到的证书原样进 ssl.ca', () => {
    const sslOptions = loadFn(MYSQL, 'sslOptions')
    const r = sslOptions({ dbSsl: true, dbSslVerify: 'ca', dbSslCa: caFile('MYSQLCA') })
    assert.equal(r.ssl.rejectUnauthorized, true)
    assert.equal(r.ssl.verifyIdentity, true, 'ca 档必须同时验证书身份，否则等于只验链')
    assert.equal(Buffer.from(r.ssl.ca).toString('utf8'), 'MYSQLCA')
  })

  // mysql2 与 node 系在"验不验证书身份"上口径不同：node（pg / ioredis 底层）在
  // rejectUnauthorized 为真时默认就验，mysql2 反过来——不给 ssl.verifyIdentity
  // 它就把 checkServerIdentity 换成恒返回 undefined 的空函数。
  // 这一条守护的是"严格档位在三引擎上拦的是同一件事"：
  // 真握手差分见 self-test/db-tls-handshake.js（L1 有"去掉这一位就放行"的基线）。
  test('严格档位的验名开关只在需要的引擎上摊（pg/redis 靠 node 默认，不重复传）', () => {
    const my = loadFn(MYSQL, 'sslOptions')
    const pg = loadFn(PG, 'sslOptions')
    const rd = loadFn(REDIS, 'tlsOptions')
    for (const mode of ['system', 'ca']) {
      const conn = { dbSsl: true, dbSslVerify: mode, dbSslCa: caFile('SHARED') }
      assert.equal(my(conn).ssl.verifyIdentity, true, `mysql ${mode} 档要带 verifyIdentity`)
      assert.equal(pg(conn).ssl.verifyIdentity, undefined, `pg ${mode} 档不该带 mysql2 私有键`)
      assert.equal(rd(conn).tls.verifyIdentity, undefined, `redis ${mode} 档不该带 mysql2 私有键`)
    }
    // 兼容线：不校验档位（旧书签的默认解释）绝不偷偷开启任何校验
    assert.equal(my({ dbSsl: true }).ssl.verifyIdentity, undefined)
    assert.equal(pg({ dbSsl: true }).ssl.verifyIdentity, undefined)
  })

  test('mysql ca 档读不到证书：在建连点抛错，不静默降级成不校验', () => {
    const sslOptions = loadFn(MYSQL, 'sslOptions')
    assert.throws(() => sslOptions({ dbSsl: true, dbSslVerify: 'ca' }), /not selected/)
    assert.throws(
      () => sslOptions({ dbSsl: true, dbSslVerify: 'ca', dbSslCa: path.join(tmpDir, 'nope.pem') }),
      /Cannot read CA certificate file/
    )
    // 抛错的意义：原因沿 async 建连链回到 UI。若改成"退回不校验"，
    // 界面会显示"已加密连接"而实际对中间人不设防
  })

  test('postgres 与 mysql 同形（跨引擎口径一致）', () => {
    const sslOptions = loadFn(PG, 'sslOptions')
    assert.deepEqual(plain(sslOptions({ dbSsl: true })), { ssl: { rejectUnauthorized: false } })
    assert.deepEqual(plain(sslOptions({ dbSsl: true, dbSslVerify: 'system' })), { ssl: { rejectUnauthorized: true } })
    assert.deepEqual(plain(sslOptions({})), {})
    assert.throws(() => sslOptions({ dbSsl: true, dbSslVerify: 'ca' }), /not selected/)
  })

  test('redis tlsOptions 用 tls 键（ioredis 透传 node tls），档位同上', () => {
    const tlsOptions = loadFn(REDIS, 'tlsOptions')
    assert.deepEqual(plain(tlsOptions({ dbSsl: true })), { tls: { rejectUnauthorized: false } })
    assert.deepEqual(plain(tlsOptions({ dbSsl: true, dbSslVerify: 'system' })), { tls: { rejectUnauthorized: true } })
    assert.deepEqual(plain(tlsOptions({})), {})
    assert.throws(() => tlsOptions({ dbSsl: true, dbSslVerify: 'ca' }), /not selected/)
  })

  test('适配器不再自己写档位判断（口径只有 db-tls 一份）', () => {
    for (const [name, src, fn] of [
      ['mysql', MYSQL, 'sslOptions'],
      ['postgres', PG, 'sslOptions'],
      ['redis', REDIS, 'tlsOptions']
    ]) {
      const body = fnBody(src, fn)
      assert.match(body, /resolveTlsProfile\(conn\)/, `${name} 的选项函数必须走 db-tls`)
      assert.doesNotMatch(body, /conn\.dbSsl \?/, `${name} 不得再自己判断开关`)
      assert.doesNotMatch(body, /rejectUnauthorized: false/, `${name} 不得再写死不校验`)
    }
  })
})

describe('B1/N1 连接签名隔离（同 host:port 改 TLS 配置不复用旧连接）', () => {
  test('mysql sig: 开关状态改变签名，其余参数不变则签名稳定', () => {
    const sig = loadFn(MYSQL, 'sig')
    const off = sig({ ...base, dbSsl: false })
    const on = sig({ ...base, dbSsl: true })
    assert.notEqual(off, on, 'ssl 开关必须进签名，否则复用旧池（改了不生效）')
    assert.equal(off, sig({ ...base }), '缺省等价关闭')
    assert.equal(on, sig({ ...base, dbSsl: true }), '同参数必须同签名（否则池永不复用）')
    assert.ok(off.endsWith('|ssl=0'), off)
    assert.ok(on.endsWith('|v=none'), `未写档位的旧书签按 none 标记：${on}`)
  })

  test('mysql sig: 三个档位 + 换 CA 内容，四种组合四个签名', () => {
    const sig = loadFn(MYSQL, 'sig')
    const tags = [
      sig({ ...base, dbSsl: true, dbSslVerify: 'none' }),
      sig({ ...base, dbSsl: true, dbSslVerify: 'system' }),
      sig({ ...base, dbSsl: true, dbSslVerify: 'ca', dbSslCa: caFile('AAA') }),
      sig({ ...base, dbSsl: true, dbSslVerify: 'ca', dbSslCa: caFile('BBB') })
    ]
    assert.equal(new Set(tags).size, 4, `签名需两两不同，否则换证书仍复用旧池：\n${tags.join('\n')}`)
  })

  test('postgres sig: 开关与档位都进签名', () => {
    const sig = loadFn(PG, 'sig')
    assert.notEqual(sig({ ...base, dbPort: 5432 }), sig({ ...base, dbPort: 5432, dbSsl: true }))
    assert.notEqual(
      sig({ ...base, dbPort: 5432, dbSsl: true, dbSslVerify: 'none' }),
      sig({ ...base, dbPort: 5432, dbSsl: true, dbSslVerify: 'system' })
    )
  })

  test('redis sig: 开关与档位都进签名', () => {
    const sig = loadFn(REDIS, 'sig')
    assert.notEqual(sig({ dbHost: 'h', dbPort: 6379 }), sig({ dbHost: 'h', dbPort: 6379, dbSsl: true }))
    assert.notEqual(
      sig({ dbHost: 'h', dbPort: 6379, dbSsl: true, dbSslVerify: 'system' }),
      sig({ dbHost: 'h', dbPort: 6379, dbSsl: true, dbSslVerify: 'ca', dbSslCa: caFile('REDISCA') })
    )
  })

  test('签名不含密码或证书内容（避免敏感信息进日志/调试输出）', () => {
    for (const [name, src] of [['mysql', MYSQL], ['postgres', PG], ['redis', REDIS]]) {
      const sig = loadFn(src, 'sig')
      const withPwd = sig({ ...base, dbPassword: 'p@ssw0rd', dbSsl: false })
      const without = sig({ ...base, dbSsl: false })
      assert.equal(withPwd, without, `${name} sig 不得包含密码`)
      assert.ok(!/p@ssw0rd/.test(withPwd))
      const caSig = sig({ ...base, dbSsl: true, dbSslVerify: 'ca', dbSslCa: caFile('SECRETCA') })
      assert.ok(!/SECRETCA/.test(caSig), `${name} sig 不得包含证书内容`)
    }
  })

  test('坏 TLS 配置下 sig 不抛（同步取池路径不能被炸掉）', () => {
    for (const [name, src] of [['mysql', MYSQL], ['postgres', PG], ['redis', REDIS]]) {
      const sig = loadFn(src, 'sig')
      assert.doesNotThrow(
        () => sig({ ...base, dbSsl: true, dbSslVerify: 'ca', dbSslCa: '' }),
        `${name} sig 在 CA 缺失时也不能抛`
      )
    }
  })
})

describe('B1/N1 建连路径必须摊入 ssl/tls 选项', () => {
  test('mysql: 池连接与测试连接都带 ssl（测试连接曾完全漏掉）', () => {
    assert.match(
      fnBody(MYSQL, 'getPool'),
      /\.\.\.sslOptions\(conn\)/,
      'getPool 未启用 ssl → 勾选 SSL 后真实连接仍是明文'
    )
    assert.match(
      fnBody(MYSQL, 'testMysqlConnection'),
      /\.\.\.sslOptions\(conn\)/,
      'testMysqlConnection 未启用 ssl → 测试连接结论与实际连接不一致'
    )
  })

  test('postgres: 客户端与测试连接都带 ssl', () => {
    // F2 起建连参数统一收口到 clientOptions（共享连接与事务专用连接共用），
    // getClient 只是取用者 —— ssl 仍在唯一的建连参数构造函数里
    assert.match(fnBody(PG, 'clientOptions'), /\.\.\.sslOptions\(conn\)/)
    assert.match(fnBody(PG, 'getClient'), /clientOptions\(conn\)/)
    assert.match(fnBody(PG, 'testPostgresConnection'), /\.\.\.sslOptions\(conn\)/)
  })

  test('redis: createClient 带 tls，且测试连接复用同一工厂', () => {
    assert.match(fnBody(REDIS, 'createClient'), /\.\.\.tlsOptions\(conn\)/)
    // 测试连接走 createClient 才能保证"测试通过=实际连得上"，不能另建一份配置
    assert.match(fnBody(REDIS, 'testRedisConnection'), /createClient\(conn\)/)
  })

  // N1 验收②的后半句是"并报证书错误"。ioredis 把建连失败统一包成
  // "Connection is closed."，真死因只在 error 事件里；createClient 又必须挂一个
  // 吞错监听（否则未监听的 error 会变成未捕获异常）。两个叠加的结果就是：
  // 证书被拦住时用户只看到"连接已关闭"，分不清是网络问题还是自己选的档位。
  test('redis: 两处建连都取回真实原因（证书错误不能被 Connection is closed 吃掉）', () => {
    assert.match(fnBody(REDIS, 'getClient'), /connectClient\(c\)/)
    assert.match(fnBody(REDIS, 'testRedisConnection'), /connectClient\(c\)/)
    assert.match(fnBody(REDIS, 'connectClient'), /withRealCause\(e, lastError\)/)
    // 只替换这种"没有信息量"的包装文案：NOAUTH / ECONNREFUSED 这些自带原因的
    // 不能改头换面，否则会绕过渲染侧的连接类错误识别（断线横幅 + 重连按钮）
    const withRealCause = loadFn(REDIS, 'withRealCause')
    const generic = new Error('Connection is closed.')
    const cert = new Error('self-signed certificate')
    cert.code = 'DEPTH_ZERO_SELF_SIGNED_CERT'
    assert.match(String(withRealCause(generic, cert).message), /self-signed certificate/)
    assert.equal(withRealCause(generic, cert).code, 'DEPTH_ZERO_SELF_SIGNED_CERT')
    const gone = new Error('Connection is closed.')
    assert.equal(withRealCause(gone, undefined), gone, '没有收集到原因时保持原错误')
    const auth = new Error('NOAUTH Authentication required.')
    assert.equal(withRealCause(auth, cert), auth, '自带原因的报错不改写')
  })

  test('抛错点在选项函数里（建连链是 async，错误以连接失败的形式回到 UI）', () => {
    for (const [name, src, fn] of [
      ['mysql', MYSQL, 'sslOptions'],
      ['postgres', PG, 'sslOptions'],
      ['redis', REDIS, 'tlsOptions']
    ]) {
      assert.match(
        fnBody(src, fn),
        /throw new Error\(profile\.error\)/,
        `${name} 要在建连点抛出原因，而不是静默降级成不校验`
      )
    }
  })
})

describe('B1/N1 贯通链路（表单 → 持久化 → 适配器）', () => {
  test('书签表单：TLS 默认关闭 + 开关/档位/CA 三个字段都在', () => {
    const form = read(FORM)
    assert.match(form, /dbSsl: false/, '默认必须关闭（不能默认开 TLS 打不开普通库）')
    assert.match(form, /name: 'dbSsl'/, '表单缺开关字段，用户无从开启')
    assert.match(form, /name: 'dbSslVerify'/, '缺档位字段则只能沿用写死不校验')
    assert.match(form, /name: 'dbSslCa'/, '缺 CA 路径字段则 ca 档无法使用')
  })

  test('表单默认档位：新建走 system，已有书签走 none', () => {
    // 依据见 createBaseInitValues：{ ...defaults, ...formData } —— 缺键的旧书签会拿到
    // defaults 的值，所以默认必须按新建/已有分开给。否则"打开表单看一眼再保存"
    // 就能把能连的自签内网盘变成连不上，而没人会怀疑到一次打开表单。
    const form = read(FORM)
    assert.match(form, /dbSslVerify: isNew \? 'system' : 'none'/, '默认档位需按新建/已有区分')
    assert.match(form, /startsWith\(newBookmarkIdPrefix\)/, '新建判定要用仓库既有的 id 前缀口径')
  })

  test('CA 路径有"选了 ca 档就必须填"的提交校验', () => {
    assert.match(
      read(FORM),
      /getFieldValue\('dbSslVerify'\) === 'ca'/,
      '缺这条校验可以保存出一个必然连不上的书签'
    )
  })

  test('书签 schema 声明 dbSsl / dbSslVerify / dbSslCa（保存校验不丢字段）', () => {
    const schemas = read(SCHEMAS)
    assert.match(schemas, /dbSsl: z\.boolean\(\)\.optional\(\)/)
    assert.match(schemas, /dbSslVerify: z\.enum\(\['none', 'system', 'ca'\]\)\.optional\(\)/)
    assert.match(schemas, /dbSslCa: z\.string\(\)\.optional\(\)/)
  })

  test('i18n 中英都有 TLS 文案', () => {
    const loc = read(LOCALES)
    const keys = [
      'dbUseSsl', 'dbSslVerifyLabel', 'dbSslVerifySystem', 'dbSslVerifyCa',
      'dbSslVerifyNone', 'dbSslCaFile', 'dbSslCaPlaceholder', 'dbSslVerifyHint'
    ]
    for (const key of keys) {
      const hits = loc.match(new RegExp('^\\s{2}' + key + ':', 'gm')) || []
      assert.equal(hits.length, 2, `${key} 需同时存在于 en 与 zhCn，实际 ${hits.length} 处`)
    }
  })

  test('风险提示要真的写明风险（档位说明不能只写档位名）', () => {
    const loc = read(LOCALES)
    assert.match(loc, /dbSslVerifyHint: '[^']*man-in-the-middle/)
    assert.match(loc, /dbSslVerifyHint: '[^']*中间人/)
  })

  test('主进程 buildConn 摊开书签全部字段（dbSsl 才能到适配器）', () => {
    assert.match(CLIENT_INDEX, /\.\.\.dbBookmark/, 'buildConn 若不摊开整份书签，dbSsl 会被丢掉')
  })
})
