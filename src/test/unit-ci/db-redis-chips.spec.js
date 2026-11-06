// U4：Redis 类型芯片 / TTL 芯片的源码契约。
// 键列表、键详情头部（非 string）、string 值面板头部三处必须共用同一对组件，
// 否则改一处颜色/口径，另外两处就会漂成"三种 Redis"。
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const JSX = path.join(ROOT, 'src/client/components/database/db-session.jsx')
// N11a #15：Redis 详情渲染已拆成独立 shipped 模块 db-redis-detail.jsx；
// 源码文本契约跟着代码走，组合读两份发布源码，断言语义与计数阈值保持原样（总数守恒）。
const DETAIL = path.join(ROOT, 'src/client/components/database/db-redis-detail.jsx')
const STYL = path.join(ROOT, 'src/client/components/database/db-session.styl')

const read = p => fs.readFileSync(p, 'utf8')

describe('U4 Redis 类型芯片 / TTL 芯片', () => {
  const jsx = read(JSX) + '\n' + read(DETAIL)
  const styl = read(STYL)

  test('类型白名单覆盖六种键类型，未知类型不着色', () => {
    const line = jsx.match(/^const REDIS_KEY_TYPES = .+$/m)
    assert.ok(line, 'REDIS_KEY_TYPES not found')
    for (const t of ['string', 'hash', 'list', 'set', 'zset', 'stream']) {
      assert.ok(line[0].includes(`'${t}'`), `${t} 不在芯片白名单`)
    }
    assert.match(jsx, /REDIS_KEY_TYPES\.includes\(t\) \? ' is-' \+ t : ''/)
  })

  test('TTL 芯片：正数显示秒数，-1/0/非法值走 dbNone', () => {
    const block = jsx.match(/const RedisTtlChip = \(\{ ttl \}\) => \{([\s\S]*?)\n\}/)
    assert.ok(block, 'RedisTtlChip not found')
    assert.match(block[1], /const has = Number\.isFinite\(n\) && n > 0/)
    assert.match(block[1], /has \? n \+ 's' : e\('dbNone'\)/)
    // 无时限是"弱化信息"，不能和有时限同样显眼
    assert.match(block[1], /has \? '' : ' is-none'/)
  })

  test('键列表的 type / ttl 两列用芯片，不再走裸 renderCell', () => {
    const typeCol = jsx.slice(jsx.indexOf("dataIndex: 'type'"), jsx.indexOf("dataIndex: 'ttl'"))
    const ttlCol = jsx.slice(jsx.indexOf("dataIndex: 'ttl'"), jsx.indexOf("dataIndex: 'ttl'") + 700)
    assert.match(typeCol, /render: v => <RedisTypeChip type=\{v\} \/>/)
    assert.match(ttlCol, /render: v => <RedisTtlChip ttl=\{v\} \/>/)
  })

  test('详情头部与 string 值面板共用同一对芯片', () => {
    const bar = jsx.slice(jsx.indexOf("className='db-redis-detail-bar'"), jsx.indexOf("className='db-redis-detail-bar'") + 500)
    assert.match(bar, /<RedisTypeChip type=\{d\.type\} \/>/)
    assert.match(bar, /<RedisTtlChip ttl=\{d\.ttl\} \/>/)
    const meta = jsx.slice(jsx.indexOf("className='db-redis-meta'"), jsx.indexOf("className='db-redis-meta'") + 500)
    assert.match(meta, /<RedisTypeChip type=\{d\.type\} \/>/)
    assert.match(meta, /<RedisTtlChip ttl=\{d\.ttl\} \/>/)
    // 旧的纯文本"type: x - ttl: y"不应再拼在头部
    assert.equal(/dbTypeMeta/.test(jsx), false, '头部不该再拼 dbTypeMeta 文本')
  })

  test('芯片样式：六种类型都有 token 颜色，且无裸色值', () => {
    const block = styl.slice(styl.indexOf('.db-redis-type-chip'), styl.indexOf('.db-redis-meta'))
    assert.ok(block.length > 0, 'chip styles missing')
    for (const t of ['string', 'hash', 'list', 'set', 'zset', 'stream']) {
      assert.ok(block.includes('&.is-' + t), `${t} 芯片缺颜色`)
    }
    assert.equal(/#[0-9a-fA-F]{3,8}|rgba?\(/.test(block), false, '芯片颜色不得写裸色值')
    assert.match(block, /border-radius var\(--radius-pill\)/)
  })
})
