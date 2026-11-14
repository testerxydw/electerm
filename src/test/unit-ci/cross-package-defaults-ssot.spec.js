const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const UNIT = path.join(ROOT, 'src/test/unit-ci')
const WHITELIST = path.join(UNIT, 'defaults-whitelist.json')
const read = p => fs.readFileSync(p, 'utf8')
const app = p => path.join(ROOT, 'src/app', p)
const client = p => path.join(ROOT, 'src/client', p)

// 只从产品源码用正则抽值：白名单绝不存取值，取值只能来自产品源码本身。
// 每条抽取先 assert.ok(m)，防止「正则没抽到 → null === null」假绿。
// 本 spec 只锁 defaults-whitelist.json 的 crossPackagePairs 登记的三组；
// 刻意双份与聚合层由 defaults-whitelist-ssot.spec.js 反向检查，
// 禁止在此追加任何全量键集一致性断言（N4 / Q5 / P0-6）。

/** 抽取一个数字定义，抽不到立即失败而不是返回 null。 */
function numberAfter (src, re, label) {
  const m = src.match(re)
  assert.ok(m, `${label}: 未抽到定义`)
  return Number(m[1])
}

/** 抽取一个单引号字符串定义，抽不到立即失败而不是返回 null。 */
function stringAfter (src, re, label) {
  const m = src.match(re)
  assert.ok(m, `${label}: 未抽到定义`)
  return m[1]
}

/** 抽取 `const NAME = <字面量>` 的右侧文本（行首锚定，避开注释与使用点）。 */
function rhsOf (src, name, label) {
  const m = src.match(new RegExp(`^[ \\t]*const[ \\t]+${name}[ \\t]*=[ \\t]*(.+)$`, 'm'))
  assert.ok(m, `${label}: ${name} 未抽到定义`)
  return m[1].trim().replace(/,[ \t]*$/, '')
}

/** 只接受纯数字或单引号字符串数组字面量；表达式型取值不属于本批次。 */
function parseLiteral (raw, label) {
  if (/^-?\d+$/.test(raw)) {
    return Number(raw)
  }
  if (/^\[[\s\S]*\]$/.test(raw)) {
    return JSON.parse(raw.replace(/'/g, '"'))
  }
  assert.fail(`${label}: 不支持的取值形态 ${raw}`)
}

describe('cross-package defaults: L1 逐值锁（只读产品源码）', () => {
  test('① BIN 4096：app 侧唯一权威点与渲染层预览逐值相等', () => {
    // P1 T04 后 app 侧三份裸定义已收口到 db-bin-prefix-limit.js，三适配器经
    // db-type-normalize.js 共享出口取常量；「不得写回裸定义 / 必须走共享出口」
    // 由 db-bin-prefix-ssot.spec.js 锁。
    const authority = read(app('common/db-bin-prefix-limit.js'))
    const renderer = read(client('components/database/value-renderers/index.js'))

    const a = numberAfter(authority, /\bexports\.BIN_PREFIX_LIMIT = (\d+)\b/, 'db-bin-prefix-limit.js')
    const b = numberAfter(renderer, /\bconst BIN_MAX_PREVIEW = (\d+)\b/, 'value-renderers/index.js')
    assert.equal(a, 4096, 'app 侧权威点偏离审计基线')
    assert.equal(b, a, '渲染层预览截断与服务端信封截断必须同值（跨包漂移）')
  })

  test('② keyword2FA：主进程聚合层与渲染层出厂默认串逐值相等', () => {
    const re = /\bkeyword2FA:\s*'([^']*)'/
    const authority = stringAfter(read(app('common/config-default.js')), re, 'config-default.js')
    const mirror = stringAfter(read(client('common/default-setting.js')), re, 'default-setting.js')
    assert.ok(authority.length > 0, 'keyword2FA 权威串不得为空')
    assert.ok(mirror.length > 0, 'keyword2FA 镜像串不得为空')
    assert.equal(mirror, authority, 'keyword2FA 默认值跨包漂移')
  })

  test('③ MCP 6 个镜像常量：渲染层与主进程权威侧逐值相等', () => {
    const authority = read(app('mcp/client/config-validate.js'))
    const mirror = read(client('common/mcp-server-form-validate.js'))
    const names = [
      'TRANSPORTS',
      'TRUST_LEVELS',
      'TIMEOUT_MIN_MS',
      'TIMEOUT_MAX_MS',
      'MAX_NAME_LENGTH',
      'MAX_COMMAND_LENGTH'
    ]
    for (const name of names) {
      const expected = parseLiteral(rhsOf(authority, name, 'config-validate.js'), name)
      const actual = parseLiteral(rhsOf(mirror, name, 'mcp-server-form-validate.js'), name)
      assert.deepEqual(actual, expected, `${name} 镜像取值漂移`)
    }
    assert.equal(names.length, 6, '只锁白名单登记的 6 个镜像常量')
  })

  test('④ 既有 term-flow L1 契约锁仍存在且被白名单登记', () => {
    const spec = path.join(UNIT, 'term-flow-contract.spec.js')
    assert.ok(fs.existsSync(spec), 'term-flow-contract.spec.js 必须仍被 unit-ci 收录')
    assert.match(read(spec), /deepEqual\(ctrl\.limits, protocol\.limits\)/)

    const whitelist = JSON.parse(read(WHITELIST))
    const pair = whitelist.deliberateDuplicates.find(entry => entry.id === 'W1-2')
    assert.ok(pair, 'W1-2 必须登记在白名单')
    assert.equal(pair.lockedBy, 'term-flow-contract.spec.js')
    // 只做登记核验，不重复实现既有 spec 的逐值断言。
  })
})
