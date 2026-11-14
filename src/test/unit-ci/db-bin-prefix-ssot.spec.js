const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const UNIT = path.join(ROOT, 'src/test/unit-ci')
const AUTHORITY_REL = 'src/app/common/db-bin-prefix-limit.js'
const RENDERER_REL = 'src/client/components/database/value-renderers/index.js'
const ADAPTERS = ['mysql', 'postgres', 'sqlite']
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// 三适配器不直接 require 权威点，而是从已被 vm 打桩 spec 复用为「真实模块」的
// db-type-normalize.js 共享出口解构；新增相对 require 会在 spec 上下文解析失败。
const SHARED_IMPORT_RE = /const\s*\{[^}]*\bBIN_PREFIX_LIMIT\b[^}]*\}\s*=\s*require\(['"]\.\.\/\.\.\/common\/db-type-normalize['"]\)/
const SHARED_EXPORT_RE = /const\s*\{\s*BIN_PREFIX_LIMIT\s*\}\s*=\s*require\(['"]\.\/db-bin-prefix-limit(?:\.js)?['"]\)/
const BARE_DEF_RE = /^[ \t]*const\s+BIN_PREFIX_LIMIT\s*=\s*\d+/m

/** 从权威点抽值，抽不到立即失败，防止 null === null 假绿。 */
function authorityValue () {
  const match = read(AUTHORITY_REL).match(/^exports\.BIN_PREFIX_LIMIT = (\d+)$/m)
  assert.ok(match, '权威点未抽到 exports.BIN_PREFIX_LIMIT 定义')
  return Number(match[1])
}

describe('db bin prefix limit: L2 单一权威点契约（P1 T04）', () => {
  test('① 权威点只有一处定义，取值保持 4096', () => {
    const src = read(AUTHORITY_REL)
    assert.equal((src.match(/^exports\.BIN_PREFIX_LIMIT\s*=/gm) || []).length, 1)
    assert.equal(authorityValue(), 4096, '收口不得改取值')
    // 全 app 侧不得再有第二份裸定义（适配器之外也不许偷偷加）。
    const found = []
    const walk = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.js$/.test(full) && BARE_DEF_RE.test(fs.readFileSync(full, 'utf8'))) {
          found.push(path.relative(ROOT, full).split(path.sep).join('/'))
        }
      }
    }
    walk(path.join(ROOT, 'src/app'))
    assert.deepEqual(found, [], `app 侧出现 BIN_PREFIX_LIMIT 裸定义：${found.join(', ')}`)
  })

  test('② 三个适配器都走共享出口、无裸定义、且真实消费', () => {
    for (const name of ADAPTERS) {
      const rel = `src/app/lib/db-client/${name}.js`
      const src = read(rel)
      assert.doesNotMatch(src, BARE_DEF_RE, `${name}.js 写回了裸定义`)
      assert.match(src, SHARED_IMPORT_RE, `${name}.js 必须从 db-type-normalize 共享出口解构`)
      assert.doesNotMatch(
        src,
        /require\(['"][^'"]*db-bin-prefix-limit/,
        `${name}.js 不得绕过共享出口直接 require 权威点（会破坏 vm 打桩 spec）`
      )
      assert.ok(
        (src.match(/\bBIN_PREFIX_LIMIT\b/g) || []).length >= 2,
        `${name}.js 必须真实消费该常量（解构 + subarray 截断）`
      )
    }
    // 共享出口只做 re-export，不得自带第二份取值。
    const norm = read('src/app/common/db-type-normalize.js')
    assert.match(norm, SHARED_EXPORT_RE, 'db-type-normalize.js 必须 re-export 权威点')
    assert.match(norm, /module\.exports\s*=\s*\{[^}]*\bBIN_PREFIX_LIMIT\b/)
    assert.doesNotMatch(norm, /BIN_PREFIX_LIMIT\s*=\s*\d/, '共享出口不得出现裸取值')
  })

  test('③ 渲染层 BIN_MAX_PREVIEW 与权威点逐值相等', () => {
    const match = read(RENDERER_REL).match(/\bconst BIN_MAX_PREVIEW = (\d+)\b/)
    assert.ok(match, 'value-renderers/index.js 未抽到 BIN_MAX_PREVIEW 定义')
    assert.equal(Number(match[1]), authorityValue(), '跨包截断上限漂移')
  })

  test('④ 白名单已把 authority 迁移到新权威点', () => {
    const whitelist = JSON.parse(fs.readFileSync(path.join(UNIT, 'defaults-whitelist.json'), 'utf8'))
    const pair = whitelist.crossPackagePairs.find(entry => entry.id === 'O09-bin-4096')
    assert.ok(pair, 'O09-bin-4096 必须仍登记在白名单')
    assert.equal(pair.authority, AUTHORITY_REL)
    assert.ok(pair.identifiers.includes('BIN_PREFIX_LIMIT'))
    assert.ok(pair.identifiers.includes('BIN_MAX_PREVIEW'))
  })
})
