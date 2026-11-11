/**
 * N5d RedisJSON 契约：
 * 1) 纯函数单测：redis-json.js 的类型识别两代口径 + JSON 文本校验（原样返回不往返）
 * 2) 源码文本契约：redis.js 的 JSON.GET 读路径 / JSON.SET 写分发 / 前端 ReJSON
 *    归入 string 值面板的三处消费点 / fake-redis 替身支持
 *
 * redis.js 依赖 ioredis 不能直接 require（全量 runner 的 NODE_ENV 下必炸，
 * 既有 spec 全用文本扫描的原因），文本层只锁"消费点存在且形状对"。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..', '..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const { isReJsonType, validateJsonText, REJSON_TYPES } = require(
  path.join(ROOT, 'src', 'app', 'lib', 'db-client', 'redis-json.js')
)

test('isReJsonType 认两代 TYPE（v2 ReJSON-RL / 1.x ReJSON-RLType）', () => {
  assert.ok(isReJsonType('ReJSON-RL'))
  assert.ok(isReJsonType('ReJSON-RLType'))
  assert.ok(REJSON_TYPES.length === 2)
  // 认不出的类型一律 false：string 键绝不能走 JSON.SET（WRONGTYPE 演成数据事故）
  assert.equal(isReJsonType('string'), false)
  assert.equal(isReJsonType('ReJSON-RLX'), false)
  assert.equal(isReJsonType(''), false)
  assert.equal(isReJsonType(null), false)
  assert.equal(isReJsonType(undefined), false)
  assert.equal(isReJsonType('rejson-rl'), false, 'TYPE 判定大小写敏感，与 redis TYPE 返回一致')
})

test('validateJsonText 合法 JSON 原样返回（不做 parse→stringify 往返）', () => {
  const pretty = '{\n  "id": 1,\n  "big": 9007199254740993\n}'
  // 大整数保真是这条规则的全部意义：往返会把 9007199254740993 吞成 ...992
  assert.equal(validateJsonText(pretty), pretty)
  assert.equal(validateJsonText('  {"a":1}  '), '  {"a":1}  ')
  assert.equal(validateJsonText('[1,2,3]'), '[1,2,3]')
  assert.equal(validateJsonText('"text"'), '"text"')
  assert.equal(validateJsonText('null'), 'null')
  assert.equal(validateJsonText('123'), '123')
  assert.equal(validateJsonText('true'), 'true')
})

test('validateJsonText 非法 JSON / 非字符串给可读错误', () => {
  assert.throws(() => validateJsonText('{broken:'), e => {
    assert.ok(/^invalid JSON: /.test(e.message))
    return true
  })
  assert.throws(() => validateJsonText(''), /invalid JSON|Unexpected end/i)
  assert.throws(() => validateJsonText(42), /must be a string/)
  assert.throws(() => validateJsonText(null), /must be a string/)
  assert.throws(() => validateJsonText(undefined), /must be a string/)
})

test('redis.js 键详情有 ReJSON 读路径（JSON.GET + string 同口径截断）', () => {
  const src = read('src/app/lib/db-client/redis.js')
  assert.ok(src.includes("case 'ReJSON-RL':"), 'getKeyDetail 缺 ReJSON-RL case')
  assert.ok(src.includes("case 'ReJSON-RLType':"), '1.x 老版 TYPE 也要认')
  assert.ok(src.includes("c.call('JSON.GET', key)"), '读路径必须走 JSON.GET')
  assert.ok(src.includes("require('./redis-json')"), '纯函数层必须独立 require')
})

test('redis.js setKey 按 TYPE 分发 JSON.SET，且不丢大整数精度', () => {
  const src = read('src/app/lib/db-client/redis.js')
  const i = src.indexOf('async function setKey')
  assert.ok(i > 0)
  const body = src.slice(i, src.indexOf('async function delKey'))
  assert.ok(body.includes('isReJsonType'), 'setKey 必须按 TYPE 分发')
  assert.ok(body.includes('validateJsonText'), 'JSON.SET 前必须过校验')
  assert.ok(body.includes("'JSON.SET'"), '写路径必须走 JSON.SET')
  // 防回退：写分支里若出现 parse→stringify 往返，>2^53 整数会被 JS number 吞精度
  assert.doesNotMatch(body, /JSON\.stringify/, '写分支禁止 stringify 往返（大整数保真）')
})

test('前端把 ReJSON 键归入 string 值面板（两处消费点）', () => {
  const session = read('src/client/components/database/db-session.jsx')
  // stringValue / stringTruncated 两处 memo 的类型判断都要放行 ReJSON
  assert.match(session, /startsWith\('ReJSON-RL'\)/)
  assert.match(session, /type === 'string' \|\| isReJsonDetail/)
  const detail = read('src/client/components/database/db-redis-detail.jsx')
  assert.match(detail, /startsWith\('ReJSON-RL'\)/)
  assert.match(detail, /isStringLike/)
  // 信息栏与 SplitPane 的排除判断也走同一口径（string 分支 body 不再套网格壳）
  assert.doesNotMatch(detail, /d\.type !== 'string'/, '排除判断必须统一走 isStringLike')
})

test('fake-redis 替身支持 JSON.GET/SET 且 COMMAND 自述只读/写归类正确', () => {
  const src = read('self-test/fake-redis.js')
  assert.ok(src.includes("'JSON.GET', 'JSON.SET'"), 'KNOWN 集合缺 JSON 命令')
  assert.match(src, /\['json\.get', -2, \['readonly'/)
  assert.match(src, /\['json\.set', -3, \['write'/)
  assert.match(src, /case 'JSON\.GET'/)
  assert.match(src, /case 'JSON\.SET'/)
  assert.match(src, /'ReJSON-RL'/, '夹具/存储必须用 v2 TYPE 形态')
})
