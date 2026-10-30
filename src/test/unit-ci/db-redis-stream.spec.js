// H7b-4a/b Redis Stream 详情：后端 getKeyDetail stream 分支 + 渲染侧归一纯函数
//  - 写操作不存在：只 XINFO / XLEN / XRANGE，全部只读
//  - XINFO 的原始形状原样回传，归一在 common/db-redis-stream.js（node:test 可直测）
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '../../..')
const REDIS_JS = path.join(ROOT, 'src/app/lib/db-client/redis.js')
const STREAM_JS = path.join(ROOT, 'src/client/common/db-redis-stream.js')
const INDEX_JS = path.join(ROOT, 'src/app/lib/db-client/index.js')

function loadRedis (opts = {}) {
  const calls = { xinfo: [], xrange: [], xlen: 0 }
  const inst = {
    on () {},
    async connect () {},
    disconnect () {},
    async select () {},
    async type () {
      return opts.type || 'stream'
    },
    async xinfo (sub, key) {
      calls.xinfo.push({ sub, key })
      if (opts.xinfoError) {
        throw new Error(opts.xinfoError)
      }
      if (sub === 'stream') {
        return opts.info === undefined ? ['length', 2, 'last-generated-id', '2-0', 'groups', 0] : opts.info
      }
      return opts.groups === undefined ? [] : opts.groups
    },
    async xrange (...args) {
      calls.xrange.push(args)
      return opts.entries || []
    },
    async xlen () {
      calls.xlen++
      if (opts.xlenError) {
        throw new Error(opts.xlenError)
      }
      return opts.xlen === undefined ? 0 : opts.xlen
    },
    async lrange () {
      return []
    },
    async ttl () {
      return -1
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
    Promise,
    BigInt
  }
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(REDIS_JS, 'utf8'), sandbox, { filename: 'redis.js' })
  return { mod: mod.exports, calls }
}

async function loadStream () {
  const mod = await import('file://' + STREAM_JS)
  return mod
}

const CONN = { dbHost: 'h', dbPort: 6379 }
const ENTRY = (id, ...fields) => [id, fields]

describe('H7b-4a getKeyDetail(stream)（后端）', () => {
  test('首页：XINFO STREAM + XINFO GROUPS + XLEN + XRANGE，原始回包原样回传', async () => {
    const { mod, calls } = loadRedis({
      info: ['length', 2, 'last-generated-id', '2-0', 'groups', 1],
      groups: [['name', 'g1', 'consumers', 1, 'pending', 0, 'last-delivered-id', '2-0']],
      entries: [ENTRY('1-0', 'a', '1'), ENTRY('2-0', 'b', '2')],
      xlen: 2
    })
    const res = await mod.getKeyDetail(CONN, { dbIndex: 0, key: 'st', pageSize: 10 })
    assert.equal(res.type, 'stream')
    assert.deepEqual(calls.xinfo.map(x => x.sub), ['stream', 'groups'])
    assert.equal(calls.xinfo[0].key, 'st')
    assert.equal(calls.xlen, 1)
    assert.deepEqual([...calls.xrange[0]], ['st', '-', '+', 'COUNT', 10])
    assert.deepEqual([...res.rows], [ENTRY('1-0', 'a', '1'), ENTRY('2-0', 'b', '2')])
    assert.equal(res.total, 2)
    assert.deepEqual([...res.streamInfo], ['length', 2, 'last-generated-id', '2-0', 'groups', 1])
    assert.equal(res.streamGroups.length, 1)
    // 已经取满（total=2, rows=2）→ 没有下一页
    assert.equal(res.nextCursor, '0')
  })

  test('游标推进一格（seq+1），不是原样传回上一页末条', async () => {
    const { mod, calls } = loadRedis({
      entries: [ENTRY('1-0', 'a', '1')],
      xlen: 5
    })
    const first = await mod.getKeyDetail(CONN, { dbIndex: 0, key: 'st', pageSize: 1 })
    assert.equal(first.nextCursor, '1-1')
    await mod.getKeyDetail(CONN, { dbIndex: 0, key: 'st', pageSize: 1, cursor: first.nextCursor })
    assert.equal(calls.xrange[1][1], '1-1')
  })

  test('seq 已满（2^64-1）翻到下一毫秒，不溢出', async () => {
    const { mod } = loadRedis({
      entries: [ENTRY('5-18446744073709551615', 'a', '1')],
      xlen: 9
    })
    const res = await mod.getKeyDetail(CONN, { dbIndex: 0, key: 'st', pageSize: 1 })
    assert.equal(res.nextCursor, '6-0')
  })

  test('非法游标一律退回第一页（不把任意字符串拼进命令）', async () => {
    const { mod, calls } = loadRedis({ entries: [], xlen: 0 })
    await mod.getKeyDetail(CONN, { dbIndex: 0, key: 'st', cursor: '$%^&*' })
    assert.equal(calls.xrange[0][1], '-')
  })

  test('本页不满一页 → nextCursor 0（不多发一次空请求）', async () => {
    const { mod } = loadRedis({ entries: [ENTRY('1-0', 'a', '1')], xlen: 100 })
    const res = await mod.getKeyDetail(CONN, { dbIndex: 0, key: 'st', pageSize: 10 })
    assert.equal(res.nextCursor, '0')
  })

  test('XINFO 被禁用：元信息/组列表回 null，条目照常返回（不把拿不到伪装成 0）', async () => {
    const { mod } = loadRedis({
      xinfoError: 'unknown command XINFO',
      entries: [ENTRY('1-0', 'a', '1')],
      xlen: 1
    })
    const res = await mod.getKeyDetail(CONN, { dbIndex: 0, key: 'st' })
    assert.equal(res.streamInfo, null)
    assert.equal(res.streamGroups, null)
    assert.equal(res.rows.length, 1)
  })

  test('XLEN 失败：total 为 undefined，条数够一页仍给下一页游标', async () => {
    const { mod } = loadRedis({
      xlenError: 'ERR xlen',
      entries: [ENTRY('1-0', 'a', '1')],
      pageSize: 1
    })
    const res = await mod.getKeyDetail(CONN, { dbIndex: 0, key: 'st', pageSize: 1 })
    assert.equal(res.total, undefined)
    assert.equal(res.nextCursor, '1-1')
  })

  test('旧类型回包里不带 streamInfo/streamGroups（不污染 hash/set 契约）', async () => {
    const { mod } = loadRedis({ type: 'list', entries: [] })
    const res = await mod.getKeyDetail(CONN, { dbIndex: 0, key: 'l' })
    assert.equal(res.type, 'list')
    assert.ok(!('streamInfo' in res))
    assert.ok(!('streamGroups' in res))
  })
})

describe('H7b-4b Stream 归一（纯函数）', () => {
  test('parseXinfoStream：RESP2 扁平数组 → 事实字段', async () => {
    const { parseXinfoStream } = await loadStream()
    const r = parseXinfoStream([
      'length', 3,
      'radix-tree-keys', 1,
      'last-generated-id', '3-0',
      'max-deleted-entry-id', '0-0',
      'entries-added', 5,
      'recorded-first-entry-id', '1-0',
      'groups', 2,
      'first-entry', ['1-0', ['a', '1']],
      'last-entry', ['3-0', ['b', '2']]
    ])
    assert.deepEqual({ ...r }, {
      length: 3,
      lastId: '3-0',
      firstId: '1-0',
      entriesAdded: 5,
      groups: 2,
      maxDeletedId: '0-0'
    })
  })

  test('parseXinfoStream：老版本没有 recorded-first-entry-id 时回落到 first-entry 的 ID', async () => {
    const { parseXinfoStream } = await loadStream()
    const r = parseXinfoStream(['length', 1, 'first-entry', ['7-0', ['a', '1']]])
    assert.equal(r.firstId, '7-0')
    assert.equal(r.entriesAdded, null)
    assert.equal(r.maxDeletedId, null)
  })

  test('parseXinfoStream：RESP3 的 map 也吃；拿不到就是 null（不是 0）', async () => {
    const { parseXinfoStream } = await loadStream()
    const r = parseXinfoStream({ length: 1, 'last-generated-id': '1-0', groups: 0 })
    assert.equal(r.length, 1)
    assert.equal(r.groups, 0)
    assert.equal(r.entriesAdded, null)
    const empty = parseXinfoStream(null)
    assert.equal(empty.length, null)
    assert.equal(empty.groups, null)
  })

  test('parseXinfoGroups：字段归一；7.0 之前没有 lag/entries-read → null', async () => {
    const { parseXinfoGroups } = await loadStream()
    const list = parseXinfoGroups([
      ['name', 'g1', 'consumers', 2, 'pending', 1, 'last-delivered-id', '9-0', 'entries-read', 4, 'lag', 0],
      ['name', 'g2', 'consumers', 0, 'pending', 0, 'last-delivered-id', '0-0']
    ])
    assert.deepEqual(list[0], {
      name: 'g1', consumers: 2, pending: 1, lastDeliveredId: '9-0', entriesRead: 4, lag: 0
    })
    assert.equal(list[1].entriesRead, null)
    assert.equal(list[1].lag, null)
  })

  test('parseXinfoGroups：无名条目跳过，非数组回空', async () => {
    const { parseXinfoGroups } = await loadStream()
    assert.equal(parseXinfoGroups([['consumers', 1]]).length, 0)
    assert.equal(parseXinfoGroups(null).length, 0)
  })

  test('parseXrangeEntries：字段对、预览单行、完整文本保留换行', async () => {
    const { parseXrangeEntries } = await loadStream()
    const rows = parseXrangeEntries([
      ENTRY('1-0', 'name', 'alice', 'payload', '{\n  "a": 1\n}')
    ])
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, '1-0')
    assert.equal(rows[0].fieldCount, 2)
    assert.equal(rows[0].text, 'name=alice\npayload={\n  "a": 1\n}')
    assert.ok(!/\n/.test(rows[0].preview), '预览不该带换行（网格是单行）')
    assert.match(rows[0].preview, /^name=alice · payload=/)
    assert.equal(rows[0].__rowKey, 0)
  })

  test('parseXrangeEntries：字段超过 3 个加 +N，超 80 字符截断', async () => {
    const { parseXrangeEntries } = await loadStream()
    const many = parseXrangeEntries([ENTRY('1-0', 'a', '1', 'b', '2', 'c', '3', 'd', '4')])
    assert.match(many[0].preview, /…\(\+1\)$/)
    assert.equal(many[0].fieldCount, 4)
    const long = parseXrangeEntries([ENTRY('1-0', 'k', 'x'.repeat(200))])
    assert.ok(long[0].preview.length <= 81, `预览应截到 80 字符，实际 ${long[0].preview.length}`)
    assert.ok(long[0].preview.endsWith('…'))
    assert.ok(long[0].text.length > 190, '完整文本不该被截')
  })

  test('parseXrangeEntries：畸形条目跳过而不是抛错；空字段条目保留 ID', async () => {
    const { parseXrangeEntries } = await loadStream()
    const rows = parseXrangeEntries([null, 'x', ENTRY('2-0')])
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, '2-0')
    assert.equal(rows[0].fieldCount, 0)
    assert.equal(rows[0].preview, '')
    assert.deepEqual(parseXrangeEntries(undefined), [])
  })
})

describe('H7b-4 接线契约', () => {
  test('getKeyDetail 的 stream 分支不碰任何写命令', () => {
    const src = fs.readFileSync(REDIS_JS, 'utf8')
    const block = src.slice(src.indexOf('case \'stream\': {'), src.indexOf('default:\n      value = null'))
    assert.ok(block.length > 0, 'stream 分支没找到')
    for (const write of ['xadd', 'xdel', 'xtrim', 'xack', 'xgroup', 'del(', 'unlink(']) {
      assert.ok(!block.includes(write), `stream 详情不该发写命令：${write}`)
    }
    assert.ok(block.includes("c.xinfo('stream', key)"), 'XINFO STREAM 缺失')
    assert.ok(block.includes("c.xinfo('groups', key)"), 'XINFO GROUPS 缺失')
    assert.ok(block.includes("c.xrange(key, streamRangeStart(cursor), '+', 'COUNT', size)"), 'XRANGE 分页缺失')
  })

  test('dbClientOp 已注册 getKeyDetail（Stream 复用同一条通道）', () => {
    const src = fs.readFileSync(INDEX_JS, 'utf8')
    assert.match(src, /getKeyDetail: 'getKeyDetail'/)
  })
})
