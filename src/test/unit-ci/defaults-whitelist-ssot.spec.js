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

// noMerge 反向检查依赖白名单自身的 guardTokens 完整性。这里把期望 token 集合
// 作为测试期望夹具锁死：它不来自产品源码、不含任何产品取值，不是第二份 SSOT，
// 只是防止「先删 token 再写值相等断言」把反向检查变成空转（V-B2 / V-B3）。
const EXPECTED_GUARD_TOKENS = {
  'W3-1': ['leftSideBarIcons', 'defaultSettingKeySet'],
  'W3-2': ['serverManagedConfigKeys', 'constantsKeySet'],
  'W3-3': ['leftSideBarIcons', 'legacyDefaultLeftSideBarIcons'],
  'W3-4': ['defaultSettingKeySet', 'aggregateLayerKeys'],
  'W2-6': ['legacyDefaultLeftSideBarIcons']
}

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
    assert.equal(whitelist.schemaVersion, 2)
    for (const key of [
      'domainFiles', 'docOnlyIds', 'namingConflictNames', 'deliberateDuplicates', 'semanticForks',
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

    // G3：lockedBy 不能只「指向任意存在的 spec」。语义锚点一律从条目自身
    // 已登记的标识符与文件路径派生，不使用 id（编号只是登记号，任何 spec
    // 提到它都不代表守护），也不硬编码 id → spec 映射制造第二份真相。
    for (const entry of entries()) {
      if (!entry.lockedBy) continue
      assert.notEqual(entry.lockedBy, 'defaults-whitelist-ssot.spec.js', '不得自我引用')
      const specSrc = read(path.join(UNIT, entry.lockedBy))
      const anchors = [
        ...(entry.identifiers || []),
        ...(entry.guardTokens || []),
        ...(entry.names || [])
      ]
      for (const key of ['files', 'authority', 'mirrors']) {
        const value = entry[key]
        const paths = typeof value === 'string' ? [value] : (Array.isArray(value) ? value : [])
        for (const rel of paths) {
          anchors.push(path.basename(rel).replace(/\.(js|jsx|json)$/, ''))
        }
      }
      assert.ok(anchors.length > 0, `${entry.id} 没有任何可判定的语义锚点`)
      assert.ok(
        anchors.some(token => token && specSrc.includes(token)),
        `${entry.id} 的 lockedBy ${entry.lockedBy} 无语义锚点命中：疑似假锁（V-E2）`
      )
    }

    // 反向：无 lockedBy 的条目必须显式登记进 docOnlyIds，防止靠「删锁」绕过锚点锁；
    // 逐值锁覆盖的 crossPackagePairs 一律不得声明为仅文档登记。
    const noLock = entries().filter(entry => !entry.lockedBy).map(entry => entry.id).sort()
    assert.deepEqual(
      whitelist.docOnlyIds.slice().sort(),
      noLock,
      'docOnlyIds 必须与实际无 lockedBy 的条目集合完全相同'
    )
    for (const id of whitelist.docOnlyIds) {
      assert.equal(
        whitelist.crossPackagePairs.some(pair => pair.id === id),
        false,
        `${id} 已被逐值锁覆盖，不得声明为仅文档登记`
      )
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
      assert.ok(EXPECTED_GUARD_TOKENS[id], `noMerge ${id} 没有 guardTokens 期望基线`)
      assert.deepEqual(
        entry.guardTokens.slice().sort(),
        EXPECTED_GUARD_TOKENS[id].slice().sort(),
        `${id} guardTokens 与基线不符：删 token 会绕过 noMerge 反向检查`
      )
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
    // G4：豁免清单不得静默扩大——files 里每个文件都必须至少真实定义一个
    // 豁免名，否则「往清单塞一个无关文件」不会被任何断言发现（V-E6）。
    for (const relFile of fork.files) {
      const src = read(path.join(ROOT, relFile))
      const hit = fork.names.some(name => {
        const re = new RegExp(`^[ \\t]*(?:export[ \\t]+)?const[ \\t]+${name}[ \\t]*=`, 'm')
        return re.test(src)
      })
      assert.ok(hit, `W2-7 豁免文件 ${relFile} 没有任何真实同名局部常量定义`)
    }

    for (const sample of whitelist.modulePrivateSample) {
      assert.match(sample, /^src\/client\/components\/.+:\d+$/)
      assert.doesNotMatch(sample, /=\s*\d/, '基线只存路径:行，不存取值')
    }
  })
})
