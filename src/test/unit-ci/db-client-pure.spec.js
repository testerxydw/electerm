/**
 * db-client 纯函数单测（P2-12 补全）
 * 覆盖：mysql 只读白名单（checkReadonly/checkWritable）、结果规范化
 * （toResult/normalizeResults）、redis HSCAN/SSCAN 游标循环（scanPage）、
 * testDbConnection 入口校验（不触网路径）。
 * 驱动（mysql2/ioredis）均为懒加载，纯函数路径不会触网。
 */

process.env.NODE_ENV = 'development'

const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

// Stub electron + electron-log 使 app 侧模块可在纯 node 环境加载
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

describe('testDbConnection 入口校验（不触网路径）', () => {
  test('不支持的 dbType 直接抛错，不建立连接', async () => {
    await assert.rejects(
      () => testDbConnection({ dbType: 'oracle' }, null),
      /unsupported db type: oracle/
    )
  })
})
