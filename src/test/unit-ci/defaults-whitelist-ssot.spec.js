const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const UNIT = path.join(ROOT, 'src/test/unit-ci')
const COMMON = path.join(ROOT, 'src/client/common')
const INDEX = path.join(COMMON, 'defaults.js')
const WHITELIST_PATH = path.join(UNIT, 'defaults-whitelist.json')
const LOCK_SPEC_PATH = path.join(UNIT, 'cross-package-defaults-ssot.spec.js')
const read = p => fs.readFileSync(p, 'utf8')

// 白名单只存路径 / 理由 / lockedBy / 标识符名，绝不存取值。
// 取值一律由 cross-package-defaults-ssot.spec.js 从产品源码正则抽取后对照，
// 否则「白名单写一个过期值」会与源码漂移而 spec 仍绿。
const whitelist = JSON.parse(read(WHITELIST_PATH))

// 允许出现的字段：任何 value / values 形态都视为把取值搬进白名单。
const ALLOWED_KEYS = new Set([
  'id', 'files', 'authority', 'mirrors', 'lockedBy',
  'reason', 'identifiers', 'nonMirroredNames', 'guardTokens', 'names'
])

/** 汇总四类白名单条目，供路径 / lockedBy / noMerge 三类断言共用。 */
function entries () {
  return [
    ...whitelist.deliberateDuplicates,
    ...whitelist.semanticForks,
    ...whitelist.crossPackageDuplicates,
    ...whitelist.crossPackagePairs
  ]
}

/** 收集所有登记路径（modulePrivateSample 去掉 :行号 后同样校验存在）。 */
function registeredPaths () {
  const out = []
  for (const entry of entries()) {
    for (const key of ['files', 'authority', 'mirrors']) {
      const value = entry[key]
      if (typeof value === 'string') out.push(value)
      else if (Array.isArray(value)) out.push(...value)
    }
  }
  for (const sample of whitelist.modulePrivateSample) {
    out.push(sample.replace(/:\d+(?::\d+)?$/, ''))
  }
  return [...new Set(out)]
}

/** 收集所有 lockedBy（必须是 bare spec 文件名，位于 src/test/unit-ci/）。 */
function lockedBySpecs () {
  return [...new Set(entries().map(entry => entry.lockedBy).filter(Boolean))]
}

describe('defaults whitelist: 可机读白名单契约（不存取值）', () => {
  test('① schemaVersion 与顶层结构固定，且不含任何取值字段', () => {
    assert.equal(whitelist.schemaVersion, 1)
    for (const key of [
      'domainFiles', 'deliberateDuplicates', 'semanticForks',
      'crossPackageDuplicates', 'crossPackagePairs', 'noMerge', 'modulePrivateSample'
    ]) {
      assert.ok(Array.isArray(whitelist[key]), `${key} must be an array`)
    }
    assert.equal(typeof whitelist.domainFilePattern, 'string')

    const raw = read(WHITELIST_PATH)
    assert.doesNotMatch(raw, /verification code,otp|Object\.freeze/)
    for (const entry of entries()) {
      for (const key of Object.keys(entry)) {
        assert.ok(ALLOWED_KEYS.has(key), `白名单条目出现未登记字段: ${key}`)
      }
      assert.doesNotMatch(JSON.stringify(entry), /"value"\s*:|"values"\s*:/)
      assert.equal(typeof entry.id, 'string')
      assert.equal(typeof entry.reason, 'string')
    }
  })

  test('② 所有登记路径存在且位于仓库内', () => {
    const paths = registeredPaths()
    assert.ok(paths.length > 0, '白名单必须登记路径')
    for (const rel of paths) {
      assert.equal(path.isAbsolute(rel), false, `路径必须是相对路径: ${rel}`)
      assert.equal(rel.includes('..'), false, `路径不得越出仓库: ${rel}`)
      assert.ok(fs.existsSync(path.join(ROOT, rel)), `登记的文件不存在: ${rel}`)
    }
  })

  test('③ domainFiles 与动态发现、索引 re-export 三方相等', () => {
    const patternRe = new RegExp(whitelist.domainFilePattern)
    // 必须用 .test() 任意位置搜索语义；从头锚定的 match 会漏掉 3 个域文件。
    const discovered = fs.readdirSync(COMMON)
      .filter(name => patternRe.test(name) && name !== 'defaults.js')
      .filter(name => fs.statSync(path.join(COMMON, name)).isFile())
      .sort()
    assert.deepEqual(whitelist.domainFiles.slice().sort(), discovered)
    const indexed = [...read(INDEX).matchAll(/from '\.\/([^']+\.js)'/g)]
      .map(m => m[1])
      .sort()
    assert.deepEqual(indexed, discovered)
  })

  test('④ 每个 lockedBy 指向 unit-ci 目录内真实存在的 spec', () => {
    const specs = lockedBySpecs()
    assert.ok(specs.length >= 4, '至少要有 4 个既有 / 本批次契约锁被登记')
    for (const name of specs) {
      assert.match(name, /^[A-Za-z0-9._-]+\.spec\.js$/, `lockedBy 必须是 bare 文件名: ${name}`)
      assert.equal(path.dirname(name), '.', `lockedBy 不得带目录: ${name}`)
      assert.ok(fs.existsSync(path.join(UNIT, name)), `lockedBy 指向的 spec 不存在: ${name}`)
    }
    assert.equal(whitelist.crossPackagePairs.length, 3)
    for (const pair of whitelist.crossPackagePairs) {
      assert.equal(pair.lockedBy, 'cross-package-defaults-ssot.spec.js')
      assert.ok(fs.existsSync(path.join(UNIT, pair.lockedBy)))
    }
  })

  test('⑤ 登记标识符真被逐值锁覆盖；noMerge 对不出现在值相等断言里', () => {
    const lockSpec = read(LOCK_SPEC_PATH)
    // 正向：每个 crossPackagePairs 登记的标识符必须出现在逐值锁 spec 中。
    for (const pair of whitelist.crossPackagePairs) {
      assert.ok(Array.isArray(pair.identifiers) && pair.identifiers.length > 0)
      for (const identifier of pair.identifiers) {
        assert.ok(lockSpec.includes(identifier), `${identifier} 已登记但未被逐值锁覆盖`)
      }
    }
    // 反向 1：部分镜像白名单里的非镜像常量不得被断言（否则会误红）。
    const w11 = whitelist.deliberateDuplicates.find(entry => entry.id === 'W1-1')
    assert.ok(w11 && Array.isArray(w11.nonMirroredNames))
    for (const name of w11.nonMirroredNames) {
      assert.equal(lockSpec.includes(name), false, `${name} 属于不镜像常量，禁止逐值锁`)
    }
    // 反向 2：noMerge 对的 guardTokens 不得出现在逐值锁 spec 里。
    const byId = new Map(entries().map(entry => [entry.id, entry]))
    for (const id of whitelist.noMerge) {
      const entry = byId.get(id)
      assert.ok(entry, `noMerge 引用的 ${id} 没有对应白名单条目`)
      assert.ok(Array.isArray(entry.guardTokens) && entry.guardTokens.length > 0, `${id} 必须有 guardTokens`)
      for (const token of entry.guardTokens) {
        assert.equal(lockSpec.includes(token), false, `${token} 属于 noMerge ${id}，禁止值相等断言`)
      }
    }
    // 禁止悄悄新增全量键集遍历式的值相等断言（N4 / Q5）。
    assert.doesNotMatch(lockSpec, /Object\.keys\(|Object\.entries\(|for \(const \[key/)
  })

  test('⑥ noMerge 引用有效、语义分叉豁免有界、基线只存路径', () => {
    const byId = new Map(entries().map(entry => [entry.id, entry]))
    for (const id of whitelist.noMerge) {
      assert.ok(byId.has(id), `未知的 noMerge id: ${id}`)
    }
    assert.equal(whitelist.noMerge.length, 5)

    // 组件局部同名豁免：每个名字都必须在所列文件里真实存在，防止豁免清单静默扩大。
    const fork = whitelist.semanticForks.find(entry => entry.id === 'W2-7')
    assert.ok(fork && Array.isArray(fork.names) && fork.names.length > 0)
    assert.equal(fork.names.includes('HIGHLIGHT_LIMITS'), false, '变异自证哨兵名不得被豁免')
    for (const name of fork.names) {
      const found = fork.files.some(file => {
        const re = new RegExp(`^[ \\t]*(?:export[ \\t]+)?const[ \\t]+${name}[ \\t]*=`, 'm')
        return re.test(read(path.join(ROOT, file)))
      })
      assert.ok(found, `豁免名 ${name} 在所列组件里没有真实定义`)
    }

    for (const sample of whitelist.modulePrivateSample) {
      assert.match(sample, /^src\/client\/components\/.+:\d+$/)
      assert.doesNotMatch(sample, /=\s*\d/, '基线只存路径:行，不存取值')
    }
  })
})
