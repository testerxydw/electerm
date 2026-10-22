/**
 * db-client 单测（P2-12）：集成路径（vm 打桩）+ 纯函数（真实模块 require）双轨
 *
 * vm 打桩轨（75b61f69 原有）：不依赖 electron/真实驱动/网络，
 *   - mysql: testMysqlConnection 成功/失败路径（end 必调）、executeSql 被拒不触网
 *   - redis: testRedisConnection（disconnect 必调）、getPageData SCAN 游标语义
 *     （透传/hasMore/type-ttl 降级/空 keys COUNT 上限）、setKey/delKey/expireKey 门控
 * 纯函数轨（真实模块 require，驱动均懒加载不触网）：
 *   - mysql: checkReadonly 白名单细化（CTE 写/多语句/INTO/空串/EXPLAIN DELETE 误拒）、
 *     checkWritable、toResult（safeCell 类型转换）、normalizeResults 单/多语句
 *   - redis: scanPage 游标循环（凑满/归零/10 轮兜底/游标透传）
 *   - index: testDbConnection 入口校验（unsupported dbType 不触网抛错）
 */
process.env.NODE_ENV = 'development'

const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')

const ROOT = path.join(__dirname, '../../..')
const MYSQL_JS = path.join(ROOT, 'src/app/lib/db-client/mysql.js')
const REDIS_JS = path.join(ROOT, 'src/app/lib/db-client/redis.js')

const LOG_STUB = { debug () {}, info () {}, warn () {}, error () {} }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ---------- vm 打桩轨辅助 ----------

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

function loadMysqlInVm (stubs) {
  return runInVm(
    fs.readFileSync(MYSQL_JS, 'utf8'),
    { '../../common/log': LOG_STUB, 'mysql2/promise': stubs },
    'mysql.js'
  )
}

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

function loadRedisInVm (RedisClass) {
  return runInVm(
    fs.readFileSync(REDIS_JS, 'utf8'),
    { ioredis: RedisClass },
    'redis.js'
  )
}

// ---------- 纯函数轨辅助：stub electron/electron-log 后 require 真实模块 ----------

const electronStub = { app: { getPath: () => '/tmp', isPackaged: false } }
const electronLogStub = {
  transports: { console: {}, file: {} },
  info: () => {},
  error: () => {},
  warn: () => {},
  log: () => {},
  debug: () => {}
}
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return electronStub
  }
  if (request === 'electron-log') {
    return electronLogStub
  }
  return originalLoad.call(this, request, parent, isMain)
}

const mysql = require('../../app/lib/db-client/mysql')
const redis = require('../../app/lib/db-client/redis')
const { testDbConnection } = require('../../app/lib/db-client/index')

const CONN = { dbHost: 'h', dbPort: 3306, dbUser: 'u', dbPassword: 'p' }

// ---------- mysql：连接测试（vm 打桩） ----------

describe('mysql testMysqlConnection（vm 打桩）', () => {
  test('成功路径：ping 返回 mysql ok，end 必调', async () => {
    const { stub, calls } = makeMysql2Stubs()
    const mod = loadMysqlInVm(stub)
    const msg = await mod.testMysqlConnection(CONN)
    assert.equal(msg, 'mysql ok')
    assert.equal(calls.pings, 1)
    assert.equal(calls.ends, 1, 'finally 必须释放一次性连接')
  })

  test('失败路径：ping 抛错上抛且 end 仍被调', async () => {
    const { stub, calls } = makeMysql2Stubs({ pingFail: true, pingErr: 'mock refused' })
    const mod = loadMysqlInVm(stub)
    await assert.rejects(
      mod.testMysqlConnection(CONN),
      /mock refused/
    )
    assert.equal(calls.ends, 1, '失败也必须 end（连接泄漏守卫）')
  })

  test('被拒语句不触网', async () => {
    const { stub, calls } = makeMysql2Stubs()
    const mod = loadMysqlInVm(stub)
    await assert.rejects(
      mod.executeSql(CONN, { sql: 'drop table t', readOnly: true }),
      /read-only mode/
    )
    assert.equal(calls.queries.length, 0, '拒绝不得建立连接/发查询')
    await sleep(1)
  })
})

// ---------- mysql：只读白名单（纯函数） ----------

describe('mysql checkReadonly（只读白名单安全边界）', () => {
  test('readOnly 关闭时放行任意语句（含写操作）', () => {
    assert.doesNotThrow(() => mysql.checkReadonly('DELETE FROM t', false))
    assert.doesNotThrow(() => mysql.checkReadonly('DROP TABLE t', false))
  })

  test('放行全部允许首关键词（大小写不敏感、容忍前导空白）', () => {
    const allowed = [
      'SELECT 1',
      '  show tables',
      'DESC t',
      'DESCRIBE t',
      'explain select 1',
      'WITH c AS (SELECT 1) SELECT * FROM c',
      'SeLeCt 1'
    ]
    for (const sql of allowed) {
      assert.doesNotThrow(() => mysql.checkReadonly(sql, true), sql)
    }
  })

  test('拒绝写操作首关键词', () => {
    const denied = [
      'INSERT INTO t VALUES (1)',
      'update t set a = 1',
      'DELETE FROM t',
      'drop table t',
      'ALTER TABLE t ADD c int',
      'truncate table t',
      'create table t (id int)',
      'REPLACE INTO t VALUES (1)',
      'grant all on *.* to u',
      'revoke all on *.* from u',
      'RENAME TABLE a TO b',
      'call sp()',
      'lock tables t read'
    ]
    for (const sql of denied) {
      assert.throws(() => mysql.checkReadonly(sql, true), /read-only mode/, sql)
    }
  })

  test('拒绝 CTE 包裹的写语句（WITH ... DELETE 绕过）', () => {
    assert.throws(
      () => mysql.checkReadonly('WITH x AS (SELECT 1) DELETE FROM t', true),
      /write keyword/
    )
  })

  test('拒绝多语句拼接写（SELECT ...; DELETE ...）', () => {
    assert.throws(
      () => mysql.checkReadonly('SELECT 1; DELETE FROM t', true),
      /write keyword/
    )
  })

  test('拒绝 SELECT ... INTO OUTFILE（into 命中写关键词）', () => {
    assert.throws(
      () => mysql.checkReadonly('SELECT * FROM t INTO OUTFILE "/tmp/x"', true),
      /write keyword/
    )
  })

  test('空串与 null 一律拒绝', () => {
    assert.throws(() => mysql.checkReadonly('', true))
    assert.throws(() => mysql.checkReadonly(null, true))
  })

  test('EXPLAIN DELETE 误拒属设计（宁可误拒不放行写操作）', () => {
    assert.throws(
      () => mysql.checkReadonly('EXPLAIN DELETE FROM t', true),
      /write keyword/
    )
  })
})

describe('mysql checkWritable（单元格写入门控）', () => {
  test('只读模式下抛错', () => {
    assert.throws(
      () => mysql.checkWritable(true),
      /read-only mode: cell update disabled/
    )
  })

  test('非只读放行（false / undefined）', () => {
    assert.doesNotThrow(() => mysql.checkWritable(false))
    assert.doesNotThrow(() => mysql.checkWritable(undefined))
  })
})

// ---------- mysql：结果规范化（纯函数） ----------

describe('mysql toResult（结果规范化）', () => {
  test('行数组：rows 保留、fields 提取 name、affected 为 undefined', () => {
    const r = mysql.toResult([{ a: 1, b: 'x' }], [{ name: 'a' }, { name: 'b' }])
    assert.deepEqual(r, {
      rows: [{ a: 1, b: 'x' }],
      affected: undefined,
      fields: ['a', 'b']
    })
  })

  test('行内特殊类型经 safeCell 转换（Date → ISO / bigint → string / 带原型对象 → string）', () => {
    const d = new Date('2026-01-02T03:04:05.000Z')
    const r = mysql.toResult([{ t: d, n: 10n, o: { a: 1 } }], [])
    assert.equal(r.rows[0].t, '2026-01-02T03:04:05.000Z')
    assert.equal(r.rows[0].n, '10')
    assert.equal(typeof r.rows[0].o, 'string')
  })

  test('OkPacket 类对象：提取 affectedRows，rows 为空数组', () => {
    const r = mysql.toResult({ affectedRows: 3 }, [])
    assert.equal(r.affected, 3)
    assert.deepEqual(r.rows, [])
  })

  test('fields 非数组时归一为空数组', () => {
    const r = mysql.toResult([{ a: 1 }], undefined)
    assert.deepEqual(r.fields, [])
  })
})

describe('mysql normalizeResults（单语句 / 多语句统一）', () => {
  test('单语句（fields[0] 非数组）返回单元素 results', () => {
    const rs = mysql.normalizeResults([{ a: 1 }], [{ name: 'a' }])
    assert.equal(rs.length, 1)
    assert.deepEqual(rs[0].rows, [{ a: 1 }])
  })

  test('多语句（fields[0] 是数组）按结果集一一对应展开', () => {
    const rows = [[{ a: 1 }], [{ b: 2 }]]
    const fields = [[{ name: 'a' }], [{ name: 'b' }]]
    const rs = mysql.normalizeResults(rows, fields)
    assert.equal(rs.length, 2)
    assert.deepEqual(rs[0].rows, [{ a: 1 }])
    assert.deepEqual(rs[0].fields, ['a'])
    assert.deepEqual(rs[1].rows, [{ b: 2 }])
    assert.deepEqual(rs[1].fields, ['b'])
  })
})

// ---------- redis：连接测试与键空间语义（vm 打桩） ----------

describe('redis testRedisConnection（vm 打桩）', () => {
  test('成功：ping PONG → redis PONG，disconnect 必调', async () => {
    const { Redis, calls } = makeRedisStub()
    const mod = loadRedisInVm(Redis)
    const msg = await mod.testRedisConnection({ dbHost: 'h', dbPort: 6379 })
    assert.equal(msg, 'redis PONG')
    assert.equal(calls.disconnects, 1, 'finally 必须断开一次性连接')
  })

  test('失败：上抛且 disconnect 仍被调', async () => {
    const { Redis, calls } = makeRedisStub({ pingFail: true })
    const mod = loadRedisInVm(Redis)
    await assert.rejects(
      mod.testRedisConnection({ dbHost: 'h', dbPort: 6379 }),
      /mock ping fail/
    )
    assert.equal(calls.disconnects, 1)
  })
})

describe('redis getPageData SCAN 游标语义（vm 打桩）', () => {
  test('cursor/match/pageSize 透传，hasMore 按 nextCursor 判定', async () => {
    const { Redis } = makeRedisStub({
      scan: ['17', ['k1', 'k2']],
      exec: [[null, 'hash'], [null, 100], [null, 'string'], [null, -1]]
    })
    const mod = loadRedisInVm(Redis)
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
    const mod = loadRedisInVm(Redis)
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
    const mod = loadRedisInVm(Redis)
    const res = await mod.getPageData(CONN, { dbIndex: 0 })
    const rows = [...res.rows]
    assert.equal(rows[0].type, 'unknown')
    assert.equal(rows[0].ttl, 100)
    assert.equal(rows[1].type, 'string')
    assert.equal(rows[1].ttl, -1)
  })

  test('空 keys：rows 空且 hasMore false；pageSize 上限 1000', async () => {
    const { Redis, calls } = makeRedisStub({ scan: ['0', []] })
    const mod = loadRedisInVm(Redis)
    const res = await mod.getPageData(CONN, { dbIndex: 0, pageSize: 5000 })
    assert.deepEqual([...res.rows], [], '空扫描结果 rows 为空')
    assert.equal(res.hasMore, false)
    // COUNT 透传上限 1000（防 5000 大 COUNT 拖垮单次 SCAN）
    assert.deepEqual([...calls.scans[0].args].slice(0, 4), ['MATCH', '*', 'COUNT', 1000])
  })
})

describe('redis setKey/delKey/expireKey 只读门控（vm 打桩）', () => {
  test('readOnly 下 set/del/expire 全拒', async () => {
    const { Redis } = makeRedisStub()
    const mod = loadRedisInVm(Redis)
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
    const mod = loadRedisInVm(Redis)
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

// ---------- redis：scanPage 游标循环（纯函数） ----------

describe('redis scanPage（HSCAN/SSCAN 游标循环）', () => {
  test('一轮凑满即停，cursor 回传 next', async () => {
    let calls = 0
    const scan = async () => {
      calls++
      return ['7', Array.from({ length: 200 }, (_, i) => `k${i}`)]
    }
    const r = await redis.scanPage(scan, 200, '0')
    assert.equal(calls, 1)
    assert.equal(r.cursor, '7')
    assert.equal(r.items.length, 200)
  })

  test('游标提前归零：不足一页也结束', async () => {
    let calls = 0
    const scan = async () => {
      calls++
      return ['0', ['a', 'b']]
    }
    const r = await redis.scanPage(scan, 200, '0')
    assert.equal(calls, 1)
    assert.equal(r.cursor, '0')
    assert.deepEqual(r.items, ['a', 'b'])
  })

  test('COUNT 不足时多轮凑满一页', async () => {
    let calls = 0
    const scan = async () => {
      calls++
      return [String(calls), Array.from({ length: 100 }, (_, i) => `k${calls}-${i}`)]
    }
    const r = await redis.scanPage(scan, 250, '0')
    // 凑满判定在每轮结束后：第 3 轮整批收下（300 >= 250 停），可能略超 pageSize
    assert.equal(calls, 3)
    assert.equal(r.items.length, 300)
    assert.equal(r.cursor, '3')
  })

  test('最多 10 轮兜底（异常实例不长时间占用）', async () => {
    let calls = 0
    const scan = async (cursor) => {
      calls++
      return [String(Number(cursor) + 1), ['x']]
    }
    const r = await redis.scanPage(scan, 1000, '0')
    assert.equal(calls, 10)
    assert.equal(r.cursor, '10')
    assert.equal(r.items.length, 10)
  })

  test('起始游标透传并字符串化（数字 cursor 转为字符串）', async () => {
    let firstCursor = null
    const scan = async (cursor) => {
      if (firstCursor === null) {
        firstCursor = cursor
      }
      return ['0', []]
    }
    await redis.scanPage(scan, 200, 123)
    assert.equal(firstCursor, '123')
  })
})

// ---------- index：testDbConnection 入口校验 ----------

describe('testDbConnection 入口校验（不触网路径）', () => {
  test('不支持的 dbType 直接抛错，不建立连接', async () => {
    await assert.rejects(
      () => testDbConnection({ dbType: 'oracle' }, null),
      /unsupported db type: oracle/
    )
  })
})
