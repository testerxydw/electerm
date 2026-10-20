// P2-12 db-client 单测补全：testConnection / 只读白名单 / SCAN 游标 / normalizeResults
// 真实源码 + vm 跑（require 打桩），不依赖 electron/真实驱动/网络：
//  - mysql: testMysqlConnection 成功/失败路径（end 必调）、executeSql 只读白名单、
//    normalizeResults 单/多语句与 affected
//  - redis: testRedisConnection、getPageData SCAN 游标语义（cursor 透传/hasMore/type-ttl 降级/
//    空 keys 不发 pipeline）、checkWritable 门控
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const MYSQL_JS = path.join(ROOT, 'src/app/lib/db-client/mysql.js')
const REDIS_JS = path.join(ROOT, 'src/app/lib/db-client/redis.js')

const LOG_STUB = { debug () {}, info () {}, warn () {}, error () {} }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function runInVm (src, stubs, filename) {
  const mod = { exports: {} }
  const sandbox = {
    module: mod,
    exports: mod.exports,
    require: spec => {
      assert.ok(stubs[spec], 'unexpected require: ' + spec)
      return stubs[spec]
    },
    console,
    setTimeout,
    clearTimeout,
    Promise
  }
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox, { filename })
  return mod.exports
}

// ---------- mysql ----------

// connConf 记录 createConnection/createPool 入参；pool 可配置 query 行为
function makeMysql2Stubs (opts = {}) {
  const calls = { connections: 0, pools: 0, pings: 0, ends: 0, queries: [] }
  const conn = {
    async ping () {
      calls.pings++
      if (opts.pingFail) {
        throw new Error(opts.pingErr || 'mock ping fail')
      }
      return 'pong'
    },
    async end () {
      calls.ends++
    }
  }
  const pool = {
    async query (sql) {
      calls.queries.push(sql)
      if (opts.queryFail) {
        throw new Error('mock query fail')
      }
      return [opts.rows !== undefined ? opts.rows : [], opts.fields || []]
    },
    async execute () {
      return [[]]
    }
  }
  const stub = {
    createConnection () {
      calls.connections++
      return conn
    },
    createPool () {
      calls.pools++
      return pool
    }
  }
  return { stub, calls }
}

function loadMysql (stubs) {
  return runInVm(
    fs.readFileSync(MYSQL_JS, 'utf8'),
    { '../../common/log': LOG_STUB, 'mysql2/promise': stubs },
    'mysql.js'
  )
}

const CONN = { dbHost: 'h', dbPort: 3306, dbUser: 'u', dbPassword: 'p' }

describe('mysql testMysqlConnection', () => {
  test('成功路径：ping 返回 mysql ok，end 必调', async () => {
    const { stub, calls } = makeMysql2Stubs()
    const mod = loadMysql(stub)
    const msg = await mod.testMysqlConnection(CONN)
    assert.equal(msg, 'mysql ok')
    assert.equal(calls.pings, 1)
    assert.equal(calls.ends, 1, 'finally 必须释放一次性连接')
  })

  test('失败路径：ping 抛错上抛且 end 仍被调', async () => {
    const { stub, calls } = makeMysql2Stubs({ pingFail: true, pingErr: 'mock refused' })
    const mod = loadMysql(stub)
    await assert.rejects(
      mod.testMysqlConnection(CONN),
      /mock refused/
    )
    assert.equal(calls.ends, 1, '失败也必须 end（连接泄漏守卫）')
  })
})

describe('mysql 只读白名单（checkReadonly via executeSql）', () => {
  const ok = async (mod, sql) => {
    await mod.executeSql(CONN, { sql, readOnly: true })
  }

  test('放行：SELECT/SHOW/DESC/EXPLAIN/WITH', async () => {
    const mod = loadMysql(makeMysql2Stubs().stub)
    for (const sql of [
      'select 1',
      'SHOW DATABASES',
      'desc t',
      'EXPLAIN select * from t',
      'with x as (select 1) select * from x'
    ]) {
      await ok(mod, sql)
    }
  })

  test('拒绝：写关键词开头 + 组合语句注入 + WITH 包写', async () => {
    for (const sql of [
      'insert into t values (1)',
      'UPDATE t set a=1',
      'delete from t',
      'DROP TABLE t',
      'truncate table t',
      'select 1; drop table t',
      'with x as (select 1) delete from t'
    ]) {
      const { stub } = makeMysql2Stubs()
      const mod = loadMysql(stub)
      await assert.rejects(
        mod.executeSql(CONN, { sql, readOnly: true }),
        /read-only mode/,
        '应拒绝: ' + sql
      )
    }
  })

  test('readOnly 关闭时写语句放行', async () => {
    const mod = loadMysql(makeMysql2Stubs({ rows: { affectedRows: 3 } }).stub)
    const res = await mod.executeSql(CONN, { sql: 'delete from t', readOnly: false })
    assert.equal([...res.results][0].affected, 3)
  })

  test('被拒语句不触网', async () => {
    const { stub, calls } = makeMysql2Stubs()
    const mod = loadMysql(stub)
    await assert.rejects(
      mod.executeSql(CONN, { sql: 'drop table t', readOnly: true }),
      /read-only mode/
    )
    assert.equal(calls.queries.length, 0, '拒绝不得建立连接/发查询')
    await sleep(1)
  })
})

describe('mysql normalizeResults（via executeSql）', () => {
  test('单语句：results 单元素，fields 提取 name', async () => {
    const rows = [{ id: 1, name: 'a' }]
    const fields = [{ name: 'id' }, { name: 'name' }]
    const mod = loadMysql(makeMysql2Stubs({ rows, fields }).stub)
    const res = await mod.executeSql(CONN, { sql: 'select * from t', readOnly: true })
    const r0 = JSON.parse(JSON.stringify([...res.results][0]))
    assert.deepEqual(r0.rows, [{ id: 1, name: 'a' }])
    assert.deepEqual(r0.fields, ['id', 'name'])
    assert.equal(r0.affected, undefined)
  })

  test('多语句（multipleStatements）：按结果集拆分', async () => {
    const stub = {
      createConnection () { throw new Error('no') },
      createPool () {
        return {
          async query () {
            // mysql2 多语句返回 [results[], fields[]]，元素本身是数组
            return [
              [[{ a: 1 }], [{ b: 2 }]],
              [[{ name: 'a' }], [{ name: 'b' }]]
            ]
          },
          async execute () { return [[]] }
        }
      }
    }
    const mod = loadMysql(stub)
    const res = await mod.executeSql(CONN, { sql: 'select 1; select 2', readOnly: true })
    assert.equal(res.results.length, 2, '两个结果集')
    const flat = JSON.parse(JSON.stringify([...res.results]))
    assert.deepEqual(flat[0].rows, [{ a: 1 }])
    assert.deepEqual(flat[1].rows, [{ b: 2 }])
    assert.equal(flat[0].fields[0], 'a')
  })

  test('affected 提取（非数组 rows 的 affectedRows）', async () => {
    const mod = loadMysql(makeMysql2Stubs({ rows: { affectedRows: 7 } }).stub)
    const res = await mod.executeSql(CONN, { sql: 'update t set a=1', readOnly: false })
    assert.equal([...res.results][0].affected, 7)
  })
})

// ---------- redis ----------

function makeRedisStub (overrides = {}) {
  const calls = { connects: 0, pings: 0, disconnects: 0, scans: [], selects: [], pipelines: 0 }
  const inst = {
    calls,
    on () {},
    opts: null,
    async connect () {
      calls.connects++
      if (overrides.connectFail) {
        throw new Error('mock redis refused')
      }
    },
    async ping () {
      calls.pings++
      if (overrides.pingFail) {
        throw new Error('mock ping fail')
      }
      return 'PONG'
    },
    disconnect () {
      calls.disconnects++
    },
    async select (i) {
      calls.selects.push(i)
    },
    async scan (cursor, ...args) {
      calls.scans.push({ cursor, args })
      if (overrides.scanFail) {
        throw new Error('mock scan fail')
      }
      return overrides.scan || ['0', []]
    },
    pipeline () {
      calls.pipelines++
      return {
        type () { return this },
        ttl () { return this },
        async exec () {
          return overrides.exec || []
        }
      }
    }
  }
  const Redis = function (opts) {
    inst.opts = opts
    return inst
  }
  Redis.inst = inst
  return { Redis, inst, calls }
}

function loadRedis (RedisClass) {
  return runInVm(
    fs.readFileSync(REDIS_JS, 'utf8'),
    { ioredis: RedisClass },
    'redis.js'
  )
}

describe('redis testRedisConnection', () => {
  test('成功：ping PONG → redis PONG，disconnect 必调', async () => {
    const { Redis, calls } = makeRedisStub()
    const mod = loadRedis(Redis)
    const msg = await mod.testRedisConnection({ dbHost: 'h', dbPort: 6379 })
    assert.equal(msg, 'redis PONG')
    assert.equal(calls.disconnects, 1, 'finally 必须断开一次性连接')
  })

  test('失败：上抛且 disconnect 仍被调', async () => {
    const { Redis, calls } = makeRedisStub({ pingFail: true })
    const mod = loadRedis(Redis)
    await assert.rejects(
      mod.testRedisConnection({ dbHost: 'h', dbPort: 6379 }),
      /mock ping fail/
    )
    assert.equal(calls.disconnects, 1)
  })
})

describe('redis getPageData SCAN 游标语义', () => {
  test('cursor/match/pageSize 透传，hasMore 按 nextCursor 判定', async () => {
    const { Redis } = makeRedisStub({
      scan: ['17', ['k1', 'k2']],
      exec: [[null, 'hash'], [null, 100], [null, 'string'], [null, -1]]
    })
    const mod = loadRedis(Redis)
    const res = await mod.getPageData(CONN, {
      dbIndex: 2, match: 'foo:*', cursor: '5', pageSize: 50
    })
    const { calls } = Redis.inst
    assert.deepEqual([...calls.scans[0].args].slice(0, 4), ['MATCH', 'foo:*', 'COUNT', 50])
    assert.equal(calls.scans[0].cursor, '5', '游标透传（非 offset 换算）')
    assert.equal(calls.selects[0], 2, 'useDb 先 select')
    assert.equal(res.hasMore, true, 'nextCursor 非 0 → 有更多')
    assert.equal(String(res.nextCursor), '17')
  })

  test('nextCursor 为 0 → hasMore false（遍历结束）', async () => {
    const { Redis } = makeRedisStub({ scan: ['0', ['a']] })
    const mod = loadRedis(Redis)
    const res = await mod.getPageData(CONN, { dbIndex: 0, cursor: '9' })
    assert.equal(res.hasMore, false)
  })

  test('type/ttl 单项失败降级 unknown/-1，不炸整页', async () => {
    const { Redis } = makeRedisStub({
      scan: ['0', ['k1', 'k2']],
      exec: [
        // k1: type 失败降级 unknown，ttl 成功 100
        ['ERR wrong type', null], [null, 100],
        // k2: type 成功 string，ttl 失败降级 -1
        [null, 'string'], ['ERR no ttl', null]
      ]
    })
    const mod = loadRedis(Redis)
    const res = await mod.getPageData(CONN, { dbIndex: 0 })
    const rows = [...res.rows]
    assert.equal(rows[0].type, 'unknown')
    assert.equal(rows[0].ttl, 100)
    assert.equal(rows[1].type, 'string')
    assert.equal(rows[1].ttl, -1)
  })

  test('空 keys：rows 空且 hasMore false；pageSize 上限 1000', async () => {
    const { Redis, calls } = makeRedisStub({ scan: ['0', []] })
    const mod = loadRedis(Redis)
    const res = await mod.getPageData(CONN, { dbIndex: 0, pageSize: 5000 })
    assert.deepEqual([...res.rows], [], '空扫描结果 rows 为空')
    assert.equal(res.hasMore, false)
    // COUNT 透传上限 1000（防 5000 大 COUNT 拖垮单次 SCAN）
    assert.deepEqual([...calls.scans[0].args].slice(0, 4), ['MATCH', '*', 'COUNT', 1000])
  })
})

describe('redis checkWritable 门控', () => {
  test('readOnly 下 set/del/expire 全拒', async () => {
    const { Redis } = makeRedisStub()
    const mod = loadRedis(Redis)
    for (const op of ['setKey', 'delKey', 'expireKey']) {
      await assert.rejects(
        mod[op]({ dbHost: 'h', dbPort: 6379 }, { dbIndex: 0, key: 'k', value: 'v', readOnly: true }),
        /read-only mode/,
        op + ' 应被只读门控拦截'
      )
    }
  })

  test('expireKey seconds<=0 走 persist', async () => {
    const { Redis, calls } = makeRedisStub()
    const mod = loadRedis(Redis)
    // inst 无 persist/expire/set 桩 → 直接在 inst 上补 spy
    const inst = Redis.inst
    inst.persist = async () => 'OK'
    inst.expire = async () => 1
    inst.set = async () => 'OK'
    inst.del = async () => 1
    let persistCalls = 0
    const origPersist = inst.persist
    inst.persist = async (...a) => {
      persistCalls++
      return origPersist(...a)
    }
    await mod.expireKey({ dbHost: 'h', dbPort: 6379 }, { dbIndex: 0, key: 'k', seconds: 0, readOnly: false })
    assert.equal(persistCalls, 1, 'seconds<=0 应调 persist（移除过期）')
    await mod.expireKey({ dbHost: 'h', dbPort: 6379 }, { dbIndex: 0, key: 'k', seconds: 10, readOnly: false })
    assert.equal(calls.selects.length >= 1, true)
  })
})
