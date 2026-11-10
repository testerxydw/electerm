const { describe, test, before } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const MOD = path.join(ROOT, 'src/client/common/db-agent-redis.js')
let R
before(async () => {
  R = await import('file://' + MOD)
})

function stringsIn (value) {
  if (typeof value === 'string') return [value]
  if (!value || typeof value !== 'object') return []
  return Object.values(value).flatMap(stringsIn)
}

function assertCounts (result, unit, fetched, returned) {
  assert.equal(result['fetched' + unit], fetched)
  assert.equal(result['returned' + unit], returned)
  assert.equal(result['omitted' + unit], fetched - returned)
}

function assertCursorSample (result, cursor) {
  assert.equal(result.nextCursor, cursor)
  assert.equal(result.hasMore, cursor !== '0')
  assert.equal(result.sampleOnly, true)
  assert.match(result.note, /sample.*not exhaustive/i)
  assert.match(result.note, /nextCursor skips omitted batch items/)
  assert.match(result.note, /hasMore only indicates server cursor/)
}

describe('normalizeRedisAgentLimit', () => {
  test('positive fractions floor to at least one; invalid limits use the fallback', () => {
    for (const [value, expected] of [[0.1, 1], ['0.5', 1], [1.9, 1], [3.9, 3], [999, 200]]) {
      assert.equal(R.normalizeRedisAgentLimit(value, 50, 200), expected)
    }
    for (const value of [0, -0.1, '', 'abc', null, undefined, NaN, Infinity, -Infinity]) {
      assert.equal(R.normalizeRedisAgentLimit(value, 50, 200), 50)
    }
  })

  test('every summarizer uses the shared limit normalization', () => {
    const rows = Array.from({ length: 300 }, (_, i) => String(i))
    for (const [limit, scan, detail, slowlog] of [
      [0.1, 1, 1, 1],
      [0, R.REDIS_AGENT_SCAN_DEFAULT, R.REDIS_AGENT_KEY_ITEMS_DEFAULT, R.REDIS_AGENT_SLOWLOG_DEFAULT],
      [Infinity, R.REDIS_AGENT_SCAN_DEFAULT, R.REDIS_AGENT_KEY_ITEMS_DEFAULT, R.REDIS_AGENT_SLOWLOG_DEFAULT],
      [99999, R.REDIS_AGENT_SCAN_MAX, R.REDIS_AGENT_KEY_ITEMS_MAX, R.REDIS_AGENT_SLOWLOG_MAX]
    ]) {
      assert.equal(R.summarizeRedisKeys({ rows: rows.map(name => ({ name })) }, { limit }).returnedKeys, scan)
      assert.equal(R.summarizeRedisKeyDetail({ type: 'list', rows }, { limit }).returnedItems, detail)
      const raw = rows.map((_, i) => [i, 1730192000, 0, ['GET', 'k']])
      assert.equal(R.summarizeRedisSlowlog(raw, { limit }).returnedEntries, slowlog)
    }
  })
})

describe('summarizeRedisKeys', () => {
  test('getPageData 一页 → 紧凑清单，游标/翻页标志原样透传', () => {
    const page = {
      rows: [
        { name: 'k1', type: 'string', ttl: -1 },
        { name: 'k2', type: 'hash', ttl: 120 }
      ],
      nextCursor: '42',
      hasMore: true
    }
    const r = R.summarizeRedisKeys(page, { dbIndex: 2, match: 'k*', limit: 10 })
    assert.equal(r.dbIndex, 2)
    assert.equal(r.match, 'k*')
    assert.equal(r.returnedKeys, 2)
    assert.deepEqual(r.keys[0], { name: 'k1', type: 'string', ttl: -1 })
    assert.equal(r.nextCursor, '42')
    assert.equal(r.hasMore, true)
    assert.equal(r.truncated, false)
  })

  test('SCAN COUNT is a positive hint, not a hard cap; final and continuing batches may overflow', () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({ name: 'k' + i, type: 'string', ttl: -1 }))
    for (const cursor of ['0', '42']) {
      const r = R.summarizeRedisKeys({ rows, nextCursor: cursor, hasMore: cursor !== '0' }, { limit: 999999 })
      assertCounts(r, 'Keys', 300, R.REDIS_AGENT_SCAN_MAX)
      assertCursorSample(r, cursor)
      assert.equal(r.truncated, true)
    }
  })

  test('complete batches are not truncated, including empty cursor-more batches', () => {
    for (const cursor of ['0', '42']) {
      for (const rows of [[], [{ name: 'k' }]]) {
        const r = R.summarizeRedisKeys({ rows, nextCursor: cursor })
        assertCounts(r, 'Keys', rows.length, rows.length)
        assertCursorSample(r, cursor)
        assert.equal(r.truncated, false)
        assert.equal(r.truncatedNames, 0)
      }
    }
  })

  test('TTL=0 expires within the current second; missing TTL remains null', () => {
    for (const ttl of [0, -1, -2, null, '']) {
      const r = R.summarizeRedisKeys({ rows: [{ name: 'k', type: 'string', ttl }] })
      assert.equal(r.keys[0].ttl, ttl === '' ? null : ttl)
    }
  })

  test('short identities stay exact, including empty and whitespace keys; long collisions are previews only', () => {
    const exact = ['', ' \t ', '中文键', 'x'.repeat(R.REDIS_AGENT_NAME_MAX_CHARS)]
    const long = ['a', 'b'].map(suffix => exact[3] + suffix)
    const r = R.summarizeRedisKeys({ rows: [...exact, ...long].map(name => ({ name })) })
    assert.deepEqual(r.keys.slice(0, exact.length), exact.map(name => ({ name })))
    for (const key of r.keys.slice(exact.length)) {
      assert.equal(key.name, null)
      assert.equal(key.nameTruncated, true)
      assert.equal(key.namePreview.length, R.REDIS_AGENT_NAME_MAX_CHARS)
      assert.ok(key.namePreview.endsWith('…'))
    }
    assert.equal(r.keys[4].namePreview, r.keys[5].namePreview)
    assert.equal(r.truncatedNames, 2)
    assert.equal(r.truncated, true)
  })

  test('入参缺省（undefined/null）回空清单，不抛', () => {
    for (const bad of [undefined, null, {}]) {
      const r = R.summarizeRedisKeys(bad)
      assert.equal(r.returnedKeys, 0)
      assert.equal(r.nextCursor, '0')
    }
  })
})

describe('summarizeRedisKeyDetail：按类型整形', () => {
  test('string：值与 ttl 透出；服务端已截断时带 totalBytes 与标记', () => {
    const d = { type: 'string', value: 'hello', ttl: -1, nextCursor: '0', fields: [] }
    const r = R.summarizeRedisKeyDetail(d, { key: 'k' })
    assert.equal(r.type, 'string')
    assert.equal(r.value, 'hello')
    assert.equal(r.ttl, -1)
    assert.equal(r.totalBytes, undefined)
    assert.equal(r.serverTruncated, undefined)
    assert.equal(r.truncated, false)
    assert.equal(r.textBudgetExhausted, false)

    const big = { type: 'string', value: 'x', ttl: 0, fields: ['truncated'], total: 300000, nextCursor: '0' }
    const b = R.summarizeRedisKeyDetail(big, { key: 'big' })
    assert.equal(b.totalBytes, 300000)
    assert.equal(b.serverTruncated, true)
    assert.equal(b.truncated, true)
    assert.equal(b.ttl, 0, 'ttl=0 是合法值，不是"没拿到"')
  })

  test('detail key identities never expose clipped names as usable keys', () => {
    const prefix = 'k'.repeat(R.REDIS_AGENT_NAME_MAX_CHARS)
    for (const key of ['', ' \t ', '中文键', prefix]) {
      const r = R.summarizeRedisKeyDetail({ type: 'string', value: 'v' }, { key })
      assert.equal(r.key, key)
      assert.equal(r.keyPreview, undefined)
      assert.equal(r.keyTruncated, undefined)
      assert.equal(r.truncated, false)
    }
    const results = ['a', 'b'].map(suffix => R.summarizeRedisKeyDetail({ type: 'string', value: 'v' }, { key: prefix + suffix }))
    for (const r of results) {
      assert.equal(r.key, null)
      assert.equal(r.keyTruncated, true)
      assert.equal(r.keyPreview.length, R.REDIS_AGENT_NAME_MAX_CHARS)
      assert.equal(r.truncated, true)
    }
    assert.equal(results[0].keyPreview, results[1].keyPreview)
  })

  test('maxValueChars is normalized and hard-capped, including the ellipsis', () => {
    const value = 'x'.repeat(20000)
    for (const [maxValueChars, expected] of [
      [0.1, 1], [3.9, 3], [0, 2000], [-1, 2000], [NaN, 2000],
      [null, 2000], ['invalid', 2000], [Infinity, 2000], [99999, 2000]
    ]) {
      const r = R.summarizeRedisKeyDetail({ type: 'string', value }, { maxValueChars })
      assert.equal(r.value.length, expected)
      assert.ok(r.value.length <= R.REDIS_AGENT_VALUE_MAX_CHARS)
      assert.ok(r.value.endsWith('…'))
      assert.equal(r.truncated, true)
      assert.equal(r.truncatedValues, 1)
      assert.equal(r.textBudgetExhausted, false)
    }
  })

  test('hash：rows 是对象 {field:value}，不按数组处理（认错就把数据说成空）', () => {
    const d = {
      type: 'hash',
      rows: { f1: 'v1', f2: 'v2' },
      fields: ['f1', 'f2'],
      total: 2,
      nextCursor: '0',
      ttl: -1
    }
    const r = R.summarizeRedisKeyDetail(d, { key: 'h' })
    assert.equal(r.type, 'hash')
    assert.deepEqual(r.fields, [{ field: 'f1', value: 'v1' }, { field: 'f2', value: 'v2' }])
    assert.equal(r.returnedFields, 2)
    assert.equal(r.totalFields, 2)
    assert.equal(r.hasMore, false)
  })

  test('hash/set/stream report omitted batch items independently of server cursor continuation', () => {
    for (const [type, rows, unit, more] of [
      ['hash', { a: '1', b: '2', c: '3' }, 'Fields', '9'],
      ['set', ['a', 'b', 'c'], 'Members', '9'],
      ['stream', [['1730192000000-0', []], ['1730192000000-1', []], ['1730192000001-0', []]], 'Entries', '1730192000001-1']
    ]) {
      for (const cursor of ['0', more]) {
        for (const limit of [2, 3]) {
          const r = R.summarizeRedisKeyDetail({ type, rows, total: 200, nextCursor: cursor }, { limit })
          assertCounts(r, unit, 3, limit)
          assertCursorSample(r, cursor)
          assert.equal(r.truncated, limit < 3)
          assert.equal(r.truncatedValues, 0)
        }
        const r = R.summarizeRedisKeyDetail({ type, rows: type === 'hash' ? {} : [], nextCursor: cursor })
        assertCounts(r, unit, 0, 0)
        assertCursorSample(r, cursor)
        assert.equal(r.truncated, false)
      }
    }
  })

  test('set：rows 是数组，members/totalMembers 归位', () => {
    const r = R.summarizeRedisKeyDetail({ type: 'set', rows: ['a', 'b', 'c'], total: 500, nextCursor: '0', ttl: -1 }, { key: 's' })
    assert.deepEqual(r.members, ['a', 'b', 'c'])
    assert.equal(r.returnedMembers, 3)
    assert.equal(r.totalMembers, 500)
    assert.equal(r.hasMore, false)
  })

  test('list：op 已封顶的样本，如实给 fetchedItems 而不是谎称全量', () => {
    const r = R.summarizeRedisKeyDetail({ type: 'list', rows: ['a', 'b'], total: undefined, ttl: -1, nextCursor: '0' }, { key: 'l' })
    assert.deepEqual(r.items, ['a', 'b'])
    assert.equal(r.returnedItems, 2)
    assert.equal(r.fetchedItems, 2)
  })

  test('zset：WITHSCORES 的 [member, score, ...] 压成 {member, score} 对', () => {
    const r = R.summarizeRedisKeyDetail({ type: 'zset', rows: ['a', '1', 'b', '2.5'], ttl: -1, nextCursor: '0' }, { key: 'z' })
    assert.deepEqual(r.members, [
      { member: 'a', score: 1 },
      { member: 'b', score: 2.5 }
    ])
    assert.equal(r.returnedMembers, 2)
  })

  test('list/zset are explicitly samples even when every fetched item fits', () => {
    for (const [type, rows, unit] of [
      ['list', ['a', 'b'], 'Items'],
      ['zset', ['a', '1', 'b', '2'], 'Members']
    ]) {
      for (const limit of [1, 2]) {
        const r = R.summarizeRedisKeyDetail({ type, rows, nextCursor: '0' }, { limit })
        assertCounts(r, unit, 2, limit)
        assert.equal(r.sampleOnly, true)
        assert.equal(r.hasMore, undefined)
        assert.equal(r['total' + unit], undefined)
        assert.match(r.note, /sample only, not exhaustive/i)
        assert.equal(r.truncated, limit < 2)
      }
    }
  })

  test('stream fields preserve order, duplicates and __proto__ as data', () => {
    const rows = [['1730192000000-0', ['a', '1', '__proto__', 'data', 'a', '2']], ['1730192000000-1', []]]
    const r = R.summarizeRedisKeyDetail({ type: 'stream', rows, total: 5, ttl: -1, nextCursor: '0' }, { key: 'st' })
    assert.equal(r.entries[0].id, rows[0][0])
    assert.deepEqual(r.entries[0].fields, [
      { field: 'a', value: '1' },
      { field: '__proto__', value: 'data' },
      { field: 'a', value: '2' }
    ])
    assertCounts(r.entries[0], 'Fields', 3, 3)
    assertCounts(r.entries[1], 'Fields', 0, 0)
    assert.equal(r.entries[0].truncated, false)
    assert.equal(r.truncated, false)
    assert.equal(r.returnedEntries, 2)
    assert.equal(r.totalLength, 5)
  })

  test('stream field count, field names and IDs are bounded with honest flags', () => {
    const fields = Array.from({ length: 70 }, (_, i) => ['f' + i, String(i)]).flat()
    const r = R.summarizeRedisKeyDetail({ type: 'stream', rows: [['1730192000000-0', fields]] })
    assert.ok(R.REDIS_AGENT_STREAM_FIELDS_MAX <= 50)
    assertCounts(r.entries[0], 'Fields', 70, R.REDIS_AGENT_STREAM_FIELDS_MAX)
    assert.equal(r.entries[0].truncated, true)
    assert.equal(r.truncated, true)
    assert.equal(r.truncatedValues, 0)
    assert.equal(r.entries[0].fields[49].field, 'f49')
    const malformedId = '1'.repeat(500) + '-0'
    const clipped = R.summarizeRedisKeyDetail({ type: 'stream', rows: [[malformedId, ['f'.repeat(500), 'v']]] })
    assert.ok(clipped.entries[0].id.length <= R.REDIS_AGENT_NAME_MAX_CHARS)
    assert.ok(clipped.entries[0].fields[0].field.length <= R.REDIS_AGENT_NAME_MAX_CHARS)
    assert.equal(clipped.entries[0].truncated, true)
    assert.equal(clipped.truncatedValues, 2)
    assert.equal(clipped.truncated, true)
  })

  test('typed array views expose only byte lengths; ordinary UTF-8 strings stay text', () => {
    for (const value of [new Uint8Array(3000), new DataView(new ArrayBuffer(3000)), Buffer.alloc(3000)]) {
      const r = R.summarizeRedisKeyDetail({ type: 'string', value }, { key: 'b' })
      assert.equal(r.value, '<binary 3000 bytes>')
      assert.equal(r.binaryValues, 1)
    }
    for (const value of ['普通 UTF-8 café', 'decoded\u0000\ufffd', '']) {
      const r = R.summarizeRedisKeyDetail({ type: 'string', value })
      assert.equal(r.value, value)
      assert.equal(r.binaryValues, 0)
      assert.equal(r.truncated, false)
    }
  })

  test('one shared 16000-character budget bounds every detail collection and counts budget omissions', () => {
    const values = Array.from({ length: 200 }, (_, i) => String(i) + 'x'.repeat(3000))
    for (const [type, rows, unit] of [
      ['hash', Object.fromEntries(values.map((v, i) => ['f' + i + 'n'.repeat(500), v])), 'Fields'],
      ['set', values, 'Members'],
      ['list', values, 'Items'],
      ['zset', values.flatMap(v => [v, '1']), 'Members'],
      ['stream', values.map((v, i) => [`1730192000000-${i}`, ['f'.repeat(500), v]]), 'Entries']
    ]) {
      const r = R.summarizeRedisKeyDetail({ type, rows, nextCursor: '0' }, { limit: 200, key: 'k'.repeat(500) })
      const chars = stringsIn(r).reduce((sum, value) => sum + value.length, 0)
      assert.ok(chars <= 16000, `${type}: ${chars} characters`)
      assert.equal(R.REDIS_AGENT_DETAIL_MAX_CHARS, 16000)
      assert.equal(r.textBudgetExhausted, true)
      assert.equal(r.truncated, true)
      assert.ok(r.truncatedValues > 0)
      assert.ok(r['omitted' + unit] > 0)
      assertCounts(r, unit, 200, r['returned' + unit])
      if (type === 'stream') assert.equal(r.entries.at(-1).truncated, true)
    }
  })

  test('stream fields share the budget across entries instead of multiplying it by field count', () => {
    const fields = Array.from({ length: 70 }, (_, i) => ['f' + i, 'v'.repeat(2000)]).flat()
    const rows = [['1730192000000-0', fields], ['1730192000000-1', fields]]
    const r = R.summarizeRedisKeyDetail({ type: 'stream', rows })
    assertCounts(r, 'Entries', 2, 1)
    const entry = r.entries[0]
    assertCounts(entry, 'Fields', 70, entry.fields.length)
    assert.ok(entry.omittedFields > 0)
    assert.equal(entry.truncated, true)
    assert.equal(r.textBudgetExhausted, true)
    assert.ok(stringsIn(r).reduce((sum, value) => sum + value.length, 0) <= 16000)
  })

  test('未知类型/键不存在：value=null + note，不抛', () => {
    for (const t of ['none', '', 'streamx']) {
      const r = R.summarizeRedisKeyDetail({ type: t, ttl: -2 }, { key: 'x' })
      assert.equal(r.value, null)
      assert.match(r.note, /not found|unsupported/i)
    }
    assert.equal(R.summarizeRedisKeyDetail(undefined, { key: 'x' }).value, null)
  })
})

describe('summarizeRedisInfo', () => {
  const RAW = [
    '# Server',
    'redis_version:7.2.4',
    'redis_mode:standalone',
    'os:Linux 6.0',
    'config_file:',
    'uptime_in_seconds:1234',
    '# Clients',
    'connected_clients:7',
    'blocked_clients:0',
    'maxclients:10000',
    '# Memory',
    'used_memory:1048576',
    'used_memory_rss:2097152',
    'maxmemory:0',
    'maxmemory_policy:noeviction',
    '# Stats',
    'keyspace_hits:900',
    'keyspace_misses:100',
    'instantaneous_ops_per_sec:12',
    'evicted_keys:0',
    '# Replication',
    'role:master',
    'connected_slaves:0',
    '# Keyspace',
    'db0:keys=6,expires=0,avg_ttl=47537',
    ''
  ].join('\r\n')

  test('概览：版本/角色/内存/命中率/总键数（缺就是 null, 0 是 0）', () => {
    const r = R.summarizeRedisInfo(RAW)
    assert.equal(r.overview.version, '7.2.4')
    assert.equal(r.overview.role, 'master')
    assert.equal(r.overview.usedMemory, 1048576)
    assert.equal(r.overview.maxMemory, 0, 'maxmemory=0 合法，不能变 null')
    assert.equal(r.overview.hitRate, 0.9)
    assert.equal(r.overview.totalKeys, 6)
    assert.equal(r.overview.totalExpires, 0)
    assert.equal(r.overview.connectedClients, 7)
    assert.equal(r.overview.config, null, 'config_file 空值算"没配"')
    assert.equal(r.truncated, false)
    assert.equal(r.truncatedStrings, 0)
  })

  test('keyspace：dbN 按索引升序，非 dbN 行跳过', () => {
    const r = R.summarizeRedisInfo(RAW + 'db10:keys=1,expires=0,avg_ttl=0\r\n')
    assert.deepEqual(r.keyspace.map(row => row.db), ['db0', 'db10'])
    assert.equal(r.keyspace[0].keys, 6)
    assert.equal(r.keyspace[0].avgTtlMs, 47537)
  })

  test('小节列表可寻址；指定 section 归一化后取值并封顶', () => {
    const r = R.summarizeRedisInfo(RAW, { section: 'Cli-ents' })
    assert.ok(r.sections.includes('clients'))
    assert.equal(r.section.name, 'clients')
    const m = r.section.entries.find(e => e.key === 'connected_clients')
    assert.equal(m.value, '7')
  })

  test('指定的 section 不存在：sectionError 列出可用的，而不是空对象', () => {
    const r = R.summarizeRedisInfo(RAW, { section: 'nope' })
    assert.equal(r.section, undefined)
    assert.match(r.sectionError, /not present.*Available:.*server/s)
  })

  test('all INFO strings and lists are bounded, including overview, names, keyspace and errors', () => {
    const huge = 'x'.repeat(1000)
    const longSection = 's'.repeat(300)
    const raw = [
      '# Server',
      ...['redis_version', 'redis_mode', 'os', 'config_file'].map(k => `${k}:${huge}`),
      '# Memory', `maxmemory_policy:${huge}`,
      '# Replication', `role:${huge}`,
      '# Keyspace',
      `db${'0'.repeat(300)}:keys=1,expires=0,avg_ttl=0`,
      ...Array.from({ length: 100 }, (_, i) => `db${i}:keys=1,expires=0,avg_ttl=0`),
      `# ${longSection}`,
      ...Array.from({ length: 80 }, (_, i) => `${huge}${i}:${huge}`),
      ...Array.from({ length: 75 }, (_, i) => `# ${longSection}${i}\nf:v`)
    ].join('\n')
    const r = R.summarizeRedisInfo(raw, { section: longSection })
    const cap = R.REDIS_AGENT_INFO_SECTION_MAX_KEYS
    for (const list of [r.sections, r.keyspace, r.section.entries]) assert.equal(list.length, cap)
    assert.ok(stringsIn(r).every(s => s.length <= R.REDIS_AGENT_NAME_MAX_CHARS))
    assert.equal(r.overview.totalKeys, 101)
    assert.equal(r.totalKeyspaceRows, 101)
    assert.equal(r.omittedKeyspaceRows, 101 - cap)
    assert.equal(r.totalSections, 80)
    assert.equal(r.omittedSections, 80 - cap)
    assert.equal(r.section.totalKeys, 80)
    assert.equal(r.section.omittedKeys, 80 - cap)
    assert.equal(r.section.truncated, true)
    assert.equal(r.truncated, true)
    assert.ok(r.truncatedStrings > 0)
    const missing = R.summarizeRedisInfo(raw, { section: huge })
    assert.ok(missing.sectionError.length <= R.REDIS_AGENT_VALUE_MAX_CHARS)
    assert.match(missing.sectionError, /not present/)
    assert.equal(missing.truncated, true)
  })

  test('INFO flags string truncation even without dropping entries', () => {
    const r = R.summarizeRedisInfo('# Server\nos:' + 'x'.repeat(300), { section: 'server' })
    assert.equal(r.section.totalKeys, 1)
    assert.equal(r.section.omittedKeys, 0)
    assert.equal(r.section.truncated, true)
    assert.equal(r.truncated, true)
    assert.equal(r.truncatedStrings, 2)
    const complete = R.summarizeRedisInfo('# Server\nos:Linux', { section: 'server' })
    assert.equal(complete.section.truncated, false)
    assert.equal(complete.truncated, false)
  })

  test('空/非字符串入参：概览全 null、键空间空表，不抛', () => {
    for (const bad of [undefined, null, 123]) {
      const r = R.summarizeRedisInfo(bad)
      assert.equal(r.overview.version, null)
      assert.deepEqual(r.keyspace, [])
      assert.deepEqual(r.sections, [])
    }
  })
})

describe('summarizeRedisSlowlog', () => {
  const SAMPLE = [
    [12, 1730192000, 42130, ['SET', 'k', 'v'], '10.0.0.5:53212', 'cli-a'],
    [13, 1730192060, 120, ['GET', 'k'], '10.0.0.5:53212', ''],
    [14, 1730192061, 60000, ['KEYS', '*'], '10.0.0.5:53212', '']
  ]

  test('默认 20 条；参数用 argText 预览，不带完整 args 数组', () => {
    const r = R.summarizeRedisSlowlog(SAMPLE)
    assert.equal(r.returnedEntries, 3)
    assert.equal(r.totalFetched, 3)
    assert.equal(r.omittedEntries, 0)
    assert.equal(r.truncated, false)
    assert.equal(r.entries[0].truncated, false)
    assert.equal(r.entries[0].id, 12)
    assert.equal(r.entries[0].command, 'SET')
    assert.equal(r.entries[0].args, 'k v')
    assert.equal(r.entries[0].clientAddr, '10.0.0.5:53212')
    assert.equal(r.entries[0].clientName, 'cli-a')
    // 绝不再往回塞一份完整参数
    assert.ok(!('rawArgs' in r.entries[0]))
  })

  test('maxDurationUs 取整批（含未展示的），limit 只截展示', () => {
    const r = R.summarizeRedisSlowlog(SAMPLE, { limit: 1 })
    assert.equal(r.returnedEntries, 1)
    assert.equal(r.totalFetched, 3)
    assert.equal(r.truncated, true)
    assert.equal(r.maxDurationUs, 60000, '最慢的没展示也要算进来')
  })

  test('超长 value 已在事实层截断，预览不随参数变长爆炸', () => {
    const huge = 'x'.repeat(5000)
    const r = R.summarizeRedisSlowlog([[1, 1730192000, 10, ['SET', 'k', huge]]])
    const a = r.entries[0].args
    assert.ok(typeof a === 'string' && a.length <= 90, `实际 ${a && a.length}`)
    assert.ok(!a.includes('x'.repeat(100)), '完整 value 混进了上下文')
    assert.equal(r.truncated, true)
    assert.equal(r.entries[0].truncated, true)
  })

  test('clientName, address and command are capped as well as argument previews', () => {
    const huge = 'x'.repeat(5000)
    const r = R.summarizeRedisSlowlog([[1, 1730192000, 0, [huge, huge], huge + ':6379', huge]])
    const entry = r.entries[0]
    for (const key of ['command', 'clientAddr', 'clientName']) {
      assert.equal(entry[key].length, R.REDIS_AGENT_NAME_MAX_CHARS)
      assert.ok(entry[key].endsWith('…'))
    }
    assert.ok(entry.args.length <= 90)
    assert.equal(entry.durationUs, 0)
    assert.equal(entry.truncated, true)
    assert.equal(r.truncated, true)
    assert.equal(r.truncatedValues, 4)
  })

  test('argument count truncation is flagged without mistaking literal ellipses for clipping', () => {
    const clipped = R.summarizeRedisSlowlog([[1, 1730192000, 0, ['GET', ...Array(9).fill('')]]])
    assert.equal(clipped.truncated, true)
    const exact = R.summarizeRedisSlowlog([[1, 1730192000, 0, ['GET', '普通 UTF-8 …']]])
    assert.equal(exact.entries[0].args, '普通 UTF-8 …')
    assert.equal(exact.truncated, false)
  })

  test('空/非数组入参：0 条、maxDurationUs=null，不抛', () => {
    for (const bad of [undefined, null, {}]) {
      const r = R.summarizeRedisSlowlog(bad)
      assert.equal(r.returnedEntries, 0)
      assert.equal(r.maxDurationUs, null)
    }
  })
})
