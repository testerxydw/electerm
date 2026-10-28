const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// B1（连接级 TLS/SSL）回归保护。
// 背景：B1 落地前 mysql 的 testMysqlConnection **完全没有** ssl 参数（勾了 SSL
// 测试连接必失败）、redis 的 createClient 没有 tls（rediss 不可用）、三处 sig()
// 不含 ssl 标记（同 host:port 切换开关后复用旧池/旧 client →"改了不生效"）。
// 这三条都不是类型错误，跑单元测试也发现不了，只有真库才暴露；本机无 mysqld/redis，
// 故用"源码契约 + 真实函数体执行"两层守护：
//   1) 函数体从源码抠出来在 vm 里跑，断言行为（改动逻辑会失败，不是字符串比对）
//   2) 建连调用点必须摊入选项函数（漏一处就是"测试通过但连不上"）

const ROOT = path.join(__dirname, '../../..')
const CLIENT = path.join(ROOT, 'src/app/lib/db-client')
const SCHEMAS = path.join(ROOT, 'src/client/common/bookmark-schemas.js')
const FORM = path.join(ROOT, 'src/client/components/bookmark-form/config/database.js')
const LOCALES = path.join(ROOT, 'src/app/common/locales-extra.js')

const read = p => fs.readFileSync(p, 'utf8')

// vm 里造的对象与宿主 realm 的原型不同，deepStrictEqual 会因原型不等而失败；
// JSON 往返把跨 realm 值拉回本 realm 再比口径（这里只关心可序列化形状）
const plain = v => JSON.parse(JSON.stringify(v))

// 抠出 `function name (conn) { ... }` 的完整定义（含内部注释）并在 vm 里执行。
// 不 new Function：跑的是发布源码本身，且过 standard 的 no-new-func
const loadFn = (src, name) => {
  const re = new RegExp('^function ' + name + ' \\(conn\\) \\{[\\s\\S]*?\\n\\}', 'm')
  const m = src.match(re)
  assert.ok(m, `function ${name}(conn) not found in source`)
  return vm.runInNewContext('(' + m[0] + ')', {})
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

describe('B1 sslOptions / tlsOptions 行为', () => {
  test('mysql sslOptions: 开=跳过证书链校验, 关=不传 ssl 键', () => {
    const sslOptions = loadFn(MYSQL, 'sslOptions')
    assert.deepEqual(plain(sslOptions({ dbSsl: true })), { ssl: { rejectUnauthorized: false } })
    // 关断必须是空对象（摊进配置后等于"没有 ssl 选项"），不能是 ssl:undefined
    assert.deepEqual(plain(sslOptions({ dbSsl: false })), {})
    assert.deepEqual(plain(sslOptions({})), {}, '缺省按关闭处理')
  })

  test('postgres sslOptions 与 mysql 同形（跨引擎口径一致）', () => {
    const sslOptions = loadFn(PG, 'sslOptions')
    assert.deepEqual(plain(sslOptions({ dbSsl: true })), { ssl: { rejectUnauthorized: false } })
    assert.deepEqual(plain(sslOptions({})), {})
  })

  test('redis tlsOptions 用 tls 键（ioredis 透传 node tls）', () => {
    const tlsOptions = loadFn(REDIS, 'tlsOptions')
    assert.deepEqual(plain(tlsOptions({ dbSsl: true })), { tls: { rejectUnauthorized: false } })
    assert.deepEqual(plain(tlsOptions({})), {})
  })
})

describe('B1 连接签名隔离（同 host:port 切开关不复用旧连接）', () => {
  const base = {
    dbHost: '127.0.0.1',
    dbPort: 3306,
    dbUser: 'root',
    dbName: 'demo'
  }

  test('mysql sig: 开关状态改变签名，其余参数不变则签名稳定', () => {
    const sig = loadFn(MYSQL, 'sig')
    const off = sig({ ...base, dbSsl: false })
    const on = sig({ ...base, dbSsl: true })
    assert.notEqual(off, on, 'ssl 开关必须进签名，否则复用旧池（改了不生效）')
    assert.equal(off, sig({ ...base }), '缺省等价关闭')
    assert.equal(on, sig({ ...base, dbSsl: true }), '同参数必须同签名（否则池永不复用）')
    assert.ok(off.endsWith('|ssl=0') && on.endsWith('|ssl=1'))
  })

  test('postgres sig: 同上', () => {
    const sig = loadFn(PG, 'sig')
    assert.notEqual(sig({ ...base, dbPort: 5432 }), sig({ ...base, dbPort: 5432, dbSsl: true }))
  })

  test('redis sig: 同上', () => {
    const sig = loadFn(REDIS, 'sig')
    assert.notEqual(sig({ dbHost: 'h', dbPort: 6379 }), sig({ dbHost: 'h', dbPort: 6379, dbSsl: true }))
  })

  test('签名不含密码（避免敏感信息进日志/调试输出）', () => {
    for (const [name, src] of [['mysql', MYSQL], ['postgres', PG], ['redis', REDIS]]) {
      const sig = loadFn(src, 'sig')
      const withPwd = sig({ ...base, dbPassword: 'p@ssw0rd', dbSsl: false })
      const without = sig({ ...base, dbSsl: false })
      assert.equal(withPwd, without, `${name} sig 不得包含密码`)
      assert.ok(!/p@ssw0rd/.test(withPwd))
    }
  })
})

describe('B1 建连路径必须摊入 ssl/tls 选项', () => {
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
})

describe('B1 贯通链路（表单 → 持久化 → 适配器）', () => {
  test('书签表单：默认关闭 + 有开关字段', () => {
    const form = read(FORM)
    assert.match(form, /dbSsl: false/, '默认必须关闭（不能默认开 TLS 打不开普通库）')
    assert.match(form, /name: 'dbSsl'/, '表单缺开关字段，用户无从开启')
  })

  test('书签 schema 声明 dbSsl（保存校验不丢字段）', () => {
    assert.match(read(SCHEMAS), /dbSsl: z\.boolean\(\)\.optional\(\)/)
  })

  test('i18n 中英都有 dbUseSsl 文案', () => {
    const loc = read(LOCALES)
    const hits = loc.match(/^\s{2}dbUseSsl:/gm) || []
    assert.equal(hits.length, 2, 'dbUseSsl 需同时存在于 en 与 zhCn')
  })

  test('主进程 buildConn 摊开书签全部字段（dbSsl 才能到适配器）', () => {
    assert.match(CLIENT_INDEX, /\.\.\.dbBookmark/, 'buildConn 若不摊开整份书签，dbSsl 会被丢掉')
  })
})
