// H7b-3 Redis 批量删键：后端 delKeys（UNLINK）+ 渲染侧分块/预览纯函数
//
// 这层薄，但每一处错都不是"少个功能"而是"删错东西"：
//   · 必须 UNLINK 不是 DEL —— DEL 在百万成员的 key 上同步回收内存，能把 redis 卡住几秒
//   · 键数组只能收非空字符串 —— `[null]` 经 String() 会变成 "null"，等于删一个真键
//   · 单次上限 1000 —— 一次误传整页/整树的键名不该变成一条几十万参数的命令
//   · 只读闸门在主进程（渲染层传参不可信），删键没有"前端忘了禁用"这条路
//   · 返回值是"实际删掉的键数"（不存在的键不计），进度只能拿它累加
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const REDIS_JS = path.join(ROOT, 'src/app/lib/db-client/redis.js')
const INDEX_JS = path.join(ROOT, 'src/app/lib/db-client/index.js')

// 与 db-redis-slowlog.spec.js 同一套路：vm 沙箱里跑真模块，ioredis 换成假 client
function loadRedis (opts = {}) {
  const calls = { unlink: [], del: [], select: [] }
  const inst = {
    on () {},
    async connect () {},
    disconnect () {},
    async select (...a) {
      calls.select.push(a)
    },
    async unlink (...a) {
      calls.unlink.push(a)
      if (opts.unlinkThrows) throw new Error(opts.unlinkThrows)
      return opts.unlink === undefined ? a.length : opts.unlink
    },
    async del (...a) {
      calls.del.push(a)
      return a.length
    },
    pipeline () {
      return { type () { return this }, ttl () { return this }, async exec () { return [] } }
    }
  }
  const Redis = function () {
    return inst
  }
  const mod = { exports: {} }
  const sandbox = {
    module: mod,
    exports: mod.exports,
    require: spec => {
      assert.equal(spec, 'ioredis', 'redis.js 多了新依赖，这个假沙箱得跟着补')
      return Redis
    },
    console,
    Promise
  }
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(REDIS_JS, 'utf8'), sandbox, { filename: 'redis.js' })
  return { mod: mod.exports, calls }
}

const CONN = { dbHost: 'h', dbPort: 6379 }

describe('H7b-3 delKeys（后端）', () => {
  test('一条 UNLINK 带上全部键名，按原序；绝不发 DEL', async () => {
    const { mod, calls } = loadRedis({ unlink: 2 })
    const n = await mod.delKeys(CONN, { dbIndex: 0, keys: ['a', 'b'] })
    assert.equal(n, 2)
    assert.deepEqual(calls.unlink, [['a', 'b']])
    assert.deepEqual(calls.del, [], 'DEL 会在大 key 上阻塞事件循环，批量删除只能走 UNLINK')
  })

  test('重复键去重：同一个键不删两次、也不占两格进度', async () => {
    const { mod, calls } = loadRedis({ unlink: 2 })
    await mod.delKeys(CONN, { dbIndex: 0, keys: ['a', 'b', 'a'] })
    assert.deepEqual(calls.unlink, [['a', 'b']])
  })

  test('返回值归一成数字：redis 回字符串/undefined 都不会把进度算成 NaN', async () => {
    const s = loadRedis({ unlink: '3' })
    assert.equal(await s.mod.delKeys(CONN, { dbIndex: 0, keys: ['a'] }), 3)
    const u = loadRedis({ unlink: undefined })
    assert.equal(await u.mod.delKeys(CONN, { dbIndex: 0, keys: ['a'] }), 1, '缺返回落成键数')
    const bad = loadRedis({ unlink: null })
    assert.equal(await bad.mod.delKeys(CONN, { dbIndex: 0, keys: ['a'] }), 0, 'null 不能变 NaN')
  })

  test('空数组 / 非数组 / 空串 / 非字符串一律抛参数错，且不发请求', async () => {
    const bad = [[], null, undefined, 'a', {}, [''], [null], [undefined], [1], ['a', '']]
    for (const keys of bad) {
      const { mod, calls } = loadRedis()
      await assert.rejects(
        () => mod.delKeys(CONN, { dbIndex: 0, keys }),
        /delKeys requires/,
        `keys=${JSON.stringify(keys)} 应被拒`
      )
      assert.deepEqual(calls.unlink, [], '参数错不能让请求先发出去')
    }
  })

  test('单次上限 1000：正好 1000 通过，1001 拒绝且不发请求', async () => {
    const ok = loadRedis({ unlink: 1000 })
    const keys = Array.from({ length: 1000 }, (_, i) => 'k' + i)
    assert.equal(await ok.mod.delKeys(CONN, { dbIndex: 0, keys }), 1000)
    assert.equal(ok.calls.unlink[0].length, 1000)

    const too = loadRedis()
    const many = Array.from({ length: 1001 }, (_, i) => 'k' + i)
    await assert.rejects(() => too.mod.delKeys(CONN, { dbIndex: 0, keys: many }), /at most 1000/)
    assert.deepEqual(too.calls.unlink, [])
  })

  test('只读模式在主进程拒绝：渲染层传 readOnly:true 才拦得住是不可接受的', async () => {
    const { mod, calls } = loadRedis()
    await assert.rejects(
      () => mod.delKeys(CONN, { dbIndex: 0, keys: ['a'], readOnly: true }),
      /read-only mode/
    )
    assert.deepEqual(calls.unlink, [])
  })

  test('在目标 db 上执行（首发改库才 select，同库不重复 select）', async () => {
    const { mod, calls } = loadRedis()
    await mod.delKeys(CONN, { dbIndex: 0, keys: ['a'] })
    await mod.delKeys(CONN, { dbIndex: 0, keys: ['b'] })
    await mod.delKeys(CONN, { dbIndex: 3, keys: ['c'] })
    // 连接上没有"当前库"记录时先 select 一次（不知道它是不是 db0），之后同库不再发
    assert.deepEqual(calls.select, [[0], [3]])
    assert.deepEqual(calls.unlink, [['a'], ['b'], ['c']])
  })

  test('服务端报错原样上抛（被 ACL 拒绝/集群 MOVED 都得让人看见）', async () => {
    const { mod } = loadRedis({ unlinkThrows: 'NOPERM this user has no permissions to run unlink' })
    await assert.rejects(() => mod.delKeys(CONN, { dbIndex: 0, keys: ['a'] }), /NOPERM/)
  })

  test('op 已挂进 redis 方法表且模块导出（漏一边就是 "unsupported op"）', () => {
    const src = fs.readFileSync(INDEX_JS, 'utf8')
    const redisBlock = /redis: \{[\s\S]*?\n {2}\}/.exec(src)
    assert.ok(redisBlock, 'OP_MAP.redis 未找到')
    assert.match(redisBlock[0], /delKeys: 'delKeys'/)
    const { mod } = loadRedis()
    assert.equal(typeof mod.delKeys, 'function')
  })
})

// ── 渲染侧纯函数（src/client/common/db-redis-del.js）──────────────────────
const load = () => import('../../client/common/db-redis-del.js')

describe('H7b-3 分块与预览纯函数', () => {
  test('默认一批 500：1200 个键切成 500/500/200，顺序不变', async () => {
    const { chunkRedisKeys, REDIS_DEL_BATCH } = await load()
    assert.equal(REDIS_DEL_BATCH, 500)
    const keys = Array.from({ length: 1200 }, (_, i) => 'k' + i)
    const chunks = chunkRedisKeys(keys)
    assert.deepEqual(chunks.map(c => c.length), [500, 500, 200])
    assert.deepEqual(chunks[0].slice(0, 2), ['k0', 'k1'])
    assert.equal(chunks[2][199], 'k1199')
  })

  test('去重保序：重复键只出现在第一批一次', async () => {
    const { chunkRedisKeys } = await load()
    assert.deepEqual(chunkRedisKeys(['b', 'a', 'b', 'c'], 2), [['b', 'a'], ['c']])
  })

  test('丢掉非字符串与空串；非数组回空列表', async () => {
    const { chunkRedisKeys } = await load()
    assert.deepEqual(chunkRedisKeys(['a', '', null, 3, undefined, 'b']), [['a', 'b']])
    assert.deepEqual(chunkRedisKeys(null), [])
    assert.deepEqual(chunkRedisKeys('a'), [])
  })

  test('非法 size 回落默认 500（0 会让 while 永远不前进）', async () => {
    const { chunkRedisKeys, REDIS_DEL_BATCH } = await load()
    const keys = Array.from({ length: 600 }, (_, i) => 'k' + i)
    for (const bad of [0, -5, NaN, 'x', undefined]) {
      const chunks = chunkRedisKeys(keys, bad)
      assert.equal(chunks.length, 2, `size=${String(bad)} 应回落 ${REDIS_DEL_BATCH}`)
      assert.equal(chunks[0].length, 500)
    }
  })

  test('预览：25 个键 → 列 20 个 + 剩 5；正好 20 个不报"还有 0 个"', async () => {
    const { delPreview } = await load()
    const keys = Array.from({ length: 25 }, (_, i) => 'k' + i)
    const p = delPreview(keys)
    assert.equal(p.shown.length, 20)
    assert.equal(p.shown[0], 'k0')
    assert.equal(p.rest, 5)
    assert.deepEqual(delPreview(keys.slice(0, 20)), { shown: keys.slice(0, 20), rest: 0 })
    assert.deepEqual(delPreview(null), { shown: [], rest: 0 })
    assert.deepEqual(delPreview(keys, 0), { shown: [], rest: 25 })
  })

  test('进度百分比：0/0 给 0 不给 NaN，超额夹到 100', async () => {
    const { delPercent } = await load()
    assert.equal(delPercent(0, 0), 0)
    assert.equal(delPercent(0, 500), 0)
    assert.equal(delPercent(250, 1000), 25)
    assert.equal(delPercent(600, 500), 100, '返回值按"实际删掉"累加，理论上不该超额，超额也不画出 >100')
    assert.equal(delPercent(NaN, 10), 0)
    assert.equal(delPercent(3, undefined), 0)
  })

  test('E1 确认文本：前 10 个键 + 还剩多少；单个超长键名截到 60', async () => {
    const { delCommandText } = await load()
    assert.equal(delCommandText(['a', 'b']), 'UNLINK a b')
    const many = Array.from({ length: 12 }, (_, i) => 'k' + i)
    assert.equal(delCommandText(many), 'UNLINK k0 k1 k2 k3 k4 k5 k6 k7 k8 k9 …(+2)')
    const long = 'x'.repeat(100)
    const text = delCommandText([long])
    assert.equal(text, 'UNLINK ' + 'x'.repeat(57) + '…', '截断后 57 字符 + 省略号')
  })
})
