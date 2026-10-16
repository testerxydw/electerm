const { describe, test } = require('node:test')
const assert = require('node:assert/strict')

const load = () => import('../../client/common/navicat-ncx.js')

// 真实 Navicat 17 导出样例中的密文/明文对 (MySQL/Redis 各一)
const VECTORS = [
  ['4319FAD36A2024FBDBE1D9EA97BAF7A2', 'password'],
  ['834BDDC40A04A4CF579C771A32A3C1BC', 'RStorage12#$']
]

const SAMPLE_NCX = `<?xml version="1.0" encoding="UTF-8"?>
<Connections Ver="1.5">
\t<Connection ConnectionName="mysql-a" ConnType="MYSQL" Host="192.168.1.10" Port="13306" UserName="root" Password="4319FAD36A2024FBDBE1D9EA97BAF7A2" SavePassword="true" SSL="false" SSH="false" Remarks=""/>
\t<Connection ConnectionName="redis-a" ConnType="REDIS" Host="192.168.1.20" Port="16379" AuthenticationMode="Password" UserName="default" Password="834BDDC40A04A4CF579C771A32A3C1BC" SavePassword="true" Remarks="备注 &amp; 测试">
\t\t<SentinelAddr Host="" Port="0"/>
\t\t<Profile ProfileName="" Host="localhost" Port="0"/>
\t</Connection>
\t<Connection ConnectionName="pg-ignore" ConnType="POSTGRESQL" Host="1.2.3.4" Port="5432" UserName="u" Password=""/>
</Connections>`

describe('navicat ncx import', () => {
  test('decrypt real password vectors', async () => {
    const { decryptNavicatPassword } = await load()
    for (const [hex, plain] of VECTORS) {
      assert.equal(await decryptNavicatPassword(hex), plain)
    }
  })

  test('non-hex passes through, bad cipher returns empty', async () => {
    const { decryptNavicatPassword } = await load()
    assert.equal(await decryptNavicatPassword('plain-pwd'), 'plain-pwd')
    assert.equal(await decryptNavicatPassword(''), '')
    // 合法 hex 但解不开 (padding 错) → 空串
    assert.equal(await decryptNavicatPassword('00000000000000000000000000000000'), '')
  })

  test('parseNcx maps mysql/redis, skips other conn types', async () => {
    const { parseNcx } = await load()
    const r = await parseNcx(SAMPLE_NCX)
    assert.equal(r.length, 2)
    const [mysql, redis] = r
    assert.equal(mysql.type, 'database')
    assert.equal(mysql.dbType, 'mysql')
    assert.equal(mysql.dbHost, '192.168.1.10')
    assert.equal(mysql.dbPort, 13306)
    assert.equal(mysql.dbUser, 'root')
    assert.equal(mysql.dbPassword, 'password')
    assert.equal(mysql.title, 'mysql-a')
    assert.equal(redis.dbType, 'redis')
    assert.equal(redis.dbHost, '192.168.1.20')
    assert.equal(redis.dbPort, 16379)
    assert.equal(redis.dbPassword, 'RStorage12#$')
    assert.equal(redis.dbUser, 'default')
    assert.equal(redis.description, '备注 & 测试')
  })

  test('missing port falls back to engine default', async () => {
    const { parseNcx } = await load()
    const txt = '<Connections Ver="1.5"><Connection ConnType="MYSQL" Host="h" UserName="u" Password=""/></Connections>'
    const r = await parseNcx(txt)
    assert.equal(r[0].dbPort, 3306)
  })

  test('empty / invalid input yields empty array', async () => {
    const { parseNcx } = await load()
    assert.deepEqual(await parseNcx(''), [])
    assert.deepEqual(await parseNcx('not xml'), [])
  })
})
