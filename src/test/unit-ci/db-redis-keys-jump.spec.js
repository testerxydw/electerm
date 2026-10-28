// R1：Redis 键列表任意跳页（不是详情跳页）
//  - 后端 scanKeysToPage：SCAN 游标不透明，跳页从 cursor=0 前向步进 pageIndex 次，
//    返回目标页 rows + 沿途每页起始游标链（前端据此重建 prev 栈）
//  - 前端接线：跳页输入 → scanKeysToPage → stack = cursors.slice(0, -1)
//  - 深跳确认、details 详情跳页不得残留
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const REDIS_JS = path.join(ROOT, 'src/app/lib/db-client/redis.js')
const INDEX_JS = path.join(ROOT, 'src/app/lib/db-client/index.js')
const JSX = path.join(ROOT, 'src/client/components/database/db-session.jsx')
const LOCALES = path.join(ROOT, 'src/app/common/locales-extra.js')

function loadRedis (opts = {}) {
  const calls = { scan: [] }
  const scans = [...(opts.scan || [])]
  const types = opts.types || {}
  const ttls = opts.ttls || {}
  const inst = {
    on () {},
    async connect () {},
    disconnect () {},
    async select () {},
    async scan (cursor, ...args) {
      calls.scan.push({ cursor, args })
      const [next, keys] = scans.shift() || ['0', []]
      return [next, keys]
    },
    pipeline () {
      const ops = []
      return {
        type (k) {
          ops.push(['type', k])
          return this
        },
        ttl (k) {
          ops.push(['ttl', k])
          return this
        },
        async exec () {
          return ops.map(([op, k]) => {
            if (op === 'type') {
              return [null, types[k] || 'string']
            }
            return [null, ttls[k] === undefined ? -1 : ttls[k]]
          })
        }
      }
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
      assert.equal(spec, 'ioredis')
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

describe('R1：scanKeysToPage 键列表前向跳页（后端）', () => {
  test('pageIndex=0 返回首页（单次 SCAN），rows 带 type/ttl', async () => {
    const { mod, calls } = loadRedis({
      scan: [['9', ['user:1', 'user:2']]],
      types: { 'user:1': 'hash', 'user:2': 'string' },
      ttls: { 'user:1': 300 }
    })
    const res = await mod.scanKeysToPage(CONN, { dbIndex: 0, pageIndex: 0, pageSize: 2, match: 'user:*' })
    assert.equal(calls.scan.length, 1)
    assert.equal(calls.scan[0].cursor, '0')
    assert.deepEqual([...calls.scan[0].args], ['MATCH', 'user:*', 'COUNT', 2])
    assert.deepEqual(res.rows.map(r => r.name), ['user:1', 'user:2'])
    assert.equal(res.rows[0].type, 'hash')
    assert.equal(res.rows[0].ttl, 300)
    assert.equal(res.rows[1].type, 'string')
    assert.equal(res.nextCursor, '9')
    assert.equal(res.hasMore, true)
    assert.deepEqual([...res.cursors], ['0'])
    assert.equal(res.pageIndex, 0)
  })

  test('pageIndex=2 前向步进两次后返回第三页，游标链完整', async () => {
    const { mod, calls } = loadRedis({
      scan: [['7', ['a']], ['13', ['b']], ['21', ['c1', 'c2']]]
    })
    const res = await mod.scanKeysToPage(CONN, { dbIndex: 0, pageIndex: 2, pageSize: 2 })
    assert.equal(calls.scan.length, 3)
    assert.deepEqual(calls.scan.map(x => x.cursor), ['0', '7', '13'])
    assert.deepEqual([...res.cursors], ['0', '7', '13'])
    assert.deepEqual(res.rows.map(r => r.name), ['c1', 'c2'])
    assert.equal(res.nextCursor, '21')
    assert.equal(res.hasMore, true)
    assert.equal(res.pageIndex, 2)
  })

  test('目标页超出末页：夹到真实末页（与 MySQL goPage 同语义）', async () => {
    const { mod } = loadRedis({
      scan: [['7', ['a']], ['0', ['b']]]
    })
    const res = await mod.scanKeysToPage(CONN, { dbIndex: 0, pageIndex: 5, pageSize: 2 })
    // 只有 2 页：跳到第 6 页 → 返回第 2 页的内容，页码也落在第 2 页
    assert.deepEqual(res.rows.map(r => r.name), ['b'])
    assert.equal(res.hasMore, false)
    assert.equal(res.nextCursor, '0')
    assert.deepEqual([...res.cursors], ['0', '7'])
    assert.equal(res.pageIndex, 1)
  })

  test('pageSize 上限 1000，match 缺省为 *', async () => {
    const { mod, calls } = loadRedis({ scan: [['0', []]] })
    await mod.scanKeysToPage(CONN, { dbIndex: 0, pageIndex: 0, pageSize: 5000 })
    assert.deepEqual([...calls.scan[0].args], ['MATCH', '*', 'COUNT', 1000])
  })

  test('极端 pageIndex 被安全上限截断（不会无限扫描）', async () => {
    // 每页都返回非 0 游标 → 一路步进到上限；断言步进次数 = 上限 + 取目标页 1 次
    const { mod, calls } = loadRedis({
      scan: Array.from({ length: 21000 }, (_, i) => [String(i + 1), []])
    })
    const res = await mod.scanKeysToPage(CONN, { dbIndex: 0, pageIndex: 1e9, pageSize: 10 })
    assert.equal(res.pageIndex, 20000)
    assert.equal(calls.scan.length, 20001)
  })

  test('负数/非法 pageIndex 回落到首页', async () => {
    const { mod, calls } = loadRedis({ scan: [['3', ['k']]] })
    const res = await mod.scanKeysToPage(CONN, { dbIndex: 0, pageIndex: -5, pageSize: 1 })
    assert.equal(calls.scan.length, 1)
    assert.equal(calls.scan[0].cursor, '0')
    assert.equal(res.pageIndex, 0)
  })
})

describe('R1：键列表跳页前端接线', () => {
  const src = fs.readFileSync(JSX, 'utf8')
  const index = fs.readFileSync(INDEX_JS, 'utf8')

  test('op 已在 redis 适配器注册且给足超时', () => {
    assert.ok(index.includes("scanKeysToPage: 'scanKeysToPage'"), 'op not registered')
    assert.ok(/scanKeysToPage:\s*60000/.test(index), 'timeout missing')
  })

  test('跳页走 scanKeysToPage 并用游标链重建 prev 栈', () => {
    assert.ok(src.includes("'scanKeysToPage'"), 'jump op wiring missing')
    assert.ok(src.includes('cursors.slice(0, -1)'), 'prev stack must be rebuilt from cursors')
    assert.ok(src.includes('jumpRedisKeysPage'), 'jump handler missing')
    assert.ok(src.includes('keyJumpTokenRef'), 'stale response guard missing')
    assert.ok(src.includes('REDIS_KEY_JUMP_WARN_PAGES'), 'deep-jump warn threshold missing')
    // 复用既有词条（与 MySQL 网格同款），不再新增重复 key
    assert.ok(src.includes('jumpRedisKeysPage(keyJumpInput)'), 'jump button wiring missing')
    assert.ok(src.includes("okText: e('dbGo')"), 'deep-jump confirm must reuse dbGo')
    assert.ok(src.includes("e('dbKeyJumpWarn')"), 'deep-jump warn copy missing')
  })

  test('详情跳页（上一版误做）不残留', () => {
    const redis = fs.readFileSync(REDIS_JS, 'utf8')
    assert.ok(!redis.includes('scanDetailToPage'), 'detail jump must be removed')
    assert.ok(!index.includes('scanDetailToPage'), 'detail jump op must be removed')
    assert.ok(!src.includes('detailCacheRef'), 'detail page cache must be removed')
    // 详情仍保留原 append 模型
    assert.ok(src.includes('selectRedisKey(redisKey, d.nextCursor, true)'), 'detail load-more must stay')
  })

  test('新增词条在 en / zh_cn 各出现一次，且不重复造跳页键', () => {
    const locales = fs.readFileSync(LOCALES, 'utf8')
    const keys = ['dbKeyJumpWarnTitle', 'dbKeyJumpWarn']
    keys.forEach(key => {
      const hits = locales.match(new RegExp('\\b' + key + ':', 'g')) || []
      assert.equal(hits.length, 2, key + ' must exist in both en and zh_cn')
    })
    // 跳页按钮/占位符复用 dbGo / dbPagePlaceholder
    assert.ok(!locales.includes('dbJumpToPage:'), 'duplicate jump label key')
    assert.ok(!locales.includes('dbJumpPagePlaceholder:'), 'duplicate jump placeholder key')
  })
})
