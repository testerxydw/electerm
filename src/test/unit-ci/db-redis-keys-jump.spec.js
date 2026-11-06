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
// N1：适配器新增依赖 './db-tls'（只依赖 fs/crypto），沙箱给真模块，顺带钉住委托关系
const DB_TLS = require(path.join(ROOT, 'src/app/lib/db-client/db-tls.js'))
const REDIS_JS = path.join(ROOT, 'src/app/lib/db-client/redis.js')
const INDEX_JS = path.join(ROOT, 'src/app/lib/db-client/index.js')
const JSX = path.join(ROOT, 'src/client/components/database/db-session.jsx')
// N11a 簇 C：跳页处理器已迁到 use-db-redis-keys.js（已接线）。
const USE_DB_REDIS_KEYS = path.join(ROOT, 'src/client/components/database/use-db-redis-keys.js')
// N11a #15：Redis 详情渲染已拆成独立 shipped 模块 db-redis-detail.jsx；
// 源码文本契约跟着代码走，组合读两份发布源码，断言语义与计数阈值保持原样（总数守恒）。
const DETAIL = path.join(ROOT, 'src/client/components/database/db-redis-detail.jsx')
// N11a：纯常量/纯函数搬到了 common/db-session-const.js，声明级断言跟过去
const SESSION_CONST = path.join(ROOT, 'src/client/common/db-session-const.js')
const LOCALES = path.join(ROOT, 'src/app/common/locales-extra.js')

function loadRedis (opts = {}) {
  const calls = { scan: [], pipelines: 0 }
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
      calls.pipelines++
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
      if (spec === './db-tls') return DB_TLS
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

// adapter 跑在 vm 沙箱里，对象来自另一个 realm（原型不同），断言前先 JSON 归一
const plain = v => JSON.parse(JSON.stringify(v))

describe('H7a-1：getPageData keysOnly 只取键名（键树全量遍历用）', () => {
  test('keysOnly：rows 只有 name，且完全不建 pipeline（不发 TYPE/TTL）', async () => {
    const { mod, calls } = loadRedis({
      scan: [['9', ['user:1:profile', 'order:2']]]
    })
    const res = await mod.getPageData(CONN, { dbIndex: 0, cursor: '0', pageSize: 100, keysOnly: true })
    assert.equal(calls.pipelines, 0, 'keysOnly 不该为每个键再发 TYPE + TTL')
    assert.deepEqual(plain(res.rows), [{ name: 'user:1:profile' }, { name: 'order:2' }])
    assert.equal(res.nextCursor, '9')
    assert.equal(res.hasMore, true)
  })

  test('默认（不带 keysOnly）行为不变：rows 带 type/ttl，pipeline 只建一次', async () => {
    const { mod, calls } = loadRedis({
      scan: [['0', ['user:1', 'user:2']]],
      types: { 'user:1': 'hash' },
      ttls: { 'user:1': 60 }
    })
    const res = await mod.getPageData(CONN, { dbIndex: 0, cursor: '0', pageSize: 100 })
    assert.equal(calls.pipelines, 1, '一批键只走一次 pipeline，不能每键一次往返')
    assert.deepEqual(plain(res.rows), [
      { name: 'user:1', type: 'hash', ttl: 60 },
      { name: 'user:2', type: 'string', ttl: -1 }
    ])
    assert.equal(res.hasMore, false)
  })

  test('keysOnly 仍守游标语义与 pageSize 上限（前端靠它驱动抓取循环）', async () => {
    const { mod, calls } = loadRedis({ scan: [['7', ['k']], ['0', []]] })
    const first = await mod.getPageData(CONN, { dbIndex: 2, cursor: '0', pageSize: 5000, match: 'a:*', keysOnly: true })
    assert.deepEqual([...calls.scan[0].args], ['MATCH', 'a:*', 'COUNT', 1000])
    const second = await mod.getPageData(CONN, { dbIndex: 2, cursor: first.nextCursor, pageSize: 1000, keysOnly: true })
    assert.equal(calls.scan[1].cursor, '7', '下一页必须从上一轮的 nextCursor 接着扫')
    assert.deepEqual(second.rows, [])
    assert.equal(second.hasMore, false)
  })

  test('keysOnly 命中空页返回空数组（不报 undefined，循环据此收尾）', async () => {
    const { mod } = loadRedis({ scan: [['0', []]] })
    const res = await mod.getPageData(CONN, { dbIndex: 0, cursor: '0', keysOnly: true })
    assert.deepEqual(plain(res.rows), [])
    assert.equal(res.nextCursor, '0')
  })
})

describe('R1：键列表跳页前端接线', () => {
  const src = fs.readFileSync(JSX, 'utf8') + '\n' + fs.readFileSync(DETAIL, 'utf8') +
    '\n' + fs.readFileSync(USE_DB_REDIS_KEYS, 'utf8')
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

// 键列表「共几页」：SCAN 答不出总数，但无过滤时 INFO keyspace 的键数是现成的，
// 用它换算总页数；带 match 或拿不到 count 时必须退回只显示当前页
describe('R1 补充：键列表总页数（无过滤时按 INFO keyspace 键数换算）', () => {
  // 跑真实源码里的换算函数（不是拷贝），签名 (count, pageSize)
  const loadPagesOf = () => {
    const src = fs.readFileSync(SESSION_CONST, 'utf8')
    const m = src.match(/const redisKeyPagesOf = \(count, pageSize\) => \{?[\s\S]*?\n\)/)
    assert.ok(m, 'redisKeyPagesOf not found in db-session-const.js')
    const expr = m[0].slice(m[0].indexOf('(count, pageSize)'))
    return vm.runInNewContext('(' + expr + ')', {})
  }

  test('换算：向上取整、空库仍算 1 页、count 缺失回 0（不显示总页数）', () => {
    const pagesOf = loadPagesOf()
    assert.equal(pagesOf(20, 10), 2)
    assert.equal(pagesOf(21, 10), 3)
    assert.equal(pagesOf(0, 10), 1)
    assert.equal(pagesOf(5, 20), 1)
    // 受管实例禁用 INFO → count 不是数字；pageSize 脏值不得除出 Infinity/NaN
    assert.equal(pagesOf(undefined, 10), 0)
    assert.equal(pagesOf(20, 0), 20)
  })

  test('接线：页码标签走 dbPageOfLabel，跳页框 placeholder 给 1-N', () => {
    const src = fs.readFileSync(JSX, 'utf8')
    const start = src.indexOf('const redisKeyDb =')
    assert.notEqual(start, -1, 'redisKeyDb lookup missing')
    const block = src.slice(start, src.indexOf('const redisArea =', start))
    // 键数按 db 名匹配（树里 name = 'db' + index），不是按数组下标猜
    assert.ok(block.includes("d.name === 'db' + redisDb"), 'count must be looked up by db name')
    // 只在无过滤时用 count
    assert.ok(block.includes("(keyList.match || '*') === '*'"), 'filtered match must not claim a total')
    assert.ok(block.includes('typeof redisKeyDb.count'), 'missing-count fallback required')
    // 页大小与取数同源：Redis 用全局 dbPageSize，不走视角 pageSize
    assert.ok(block.includes('getDbPageSize()'), 'page size source drifted')
    // 真末页以实测为准，不得出现「第 3 / 5 页」而下一页已禁用
    assert.ok(block.includes('!keyList.hasMore'), 'last page must fall back to measured page count')
    assert.ok(block.includes('redisKeyPagesShow'), 'display value must go through the last-page clamp')
    // H1a-4：页码文案提为常量（分页条换共用 DbGridPager），从常量定义处起截
    const pager = src.slice(src.indexOf('const redisPageNoText'), src.indexOf('mainArea'))
    assert.ok(pager.includes("e('dbPageOfLabel')"), 'pager label must switch to 第 N / M 页')
    assert.ok(pager.includes("e('dbPageLabel')"), 'fallback label must stay')
    assert.ok(pager.includes("'1-' + redisKeyPagesShow"), 'jump input must hint the page range')
    assert.ok(pager.includes("e('dbKeysTotal')"), 'page label should expose the key count it derived from')
    // 标签与跳页框必须用同一个钳制后的值，不能一处显示 3/5、另一处提示 1-3
    assert.ok(!pager.includes("'1-' + redisKeyPages "), 'jump placeholder must use the clamped value')
  })

  test('新词条在 en / zh_cn 各出现一次', () => {
    const locales = fs.readFileSync(LOCALES, 'utf8')
    ;['dbPageOfLabel', 'dbKeysTotal'].forEach(key => {
      const hits = locales.match(new RegExp('\\b' + key + ':', 'g')) || []
      assert.equal(hits.length, 2, key + ' must exist in both en and zh_cn')
    })
    // 不重复造既有语义的键
    assert.ok(!locales.includes('dbTotalPages:'), 'duplicate total pages key')
  })
})
