const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../../..')
const SCRIPT = path.join(ROOT, 'src/build/bin/inventory-defaults.js')
const WHITELIST = path.join(ROOT, 'src/test/unit-ci/defaults-whitelist.json')
const read = p => fs.readFileSync(p, 'utf8')

// 域级 SSOT 哨兵名：一旦出现在「同名不同值」集合里，说明单点定义发生漂移，
// 必须修源码，而不是把它登记进白名单（P0-6：不得靠加白名单例外变绿）。
const SSOT_SENTINELS = [
  'HIGHLIGHT_LIMITS', 'BIN_PREFIX_LIMIT', 'BIN_MAX_PREVIEW',
  'FLOW_LIMITS', 'maxSyncPayloadKb'
]

/** 复用盘点脚本的 --json 输出，不重复实现扫描；脚本本身由 inventory spec 独立复算锁住。 */
function conflicts () {
  const out = execFileSync(process.execPath, [SCRIPT, '--json'], {
    cwd: ROOT,
    encoding: 'utf8'
  })
  return JSON.parse(out).conflicts
}

describe('defaults naming: 同名不同值登记护栏（T03）', () => {
  test('① 源码同名不同值集合与白名单登记完全相等（新增 / 删除均红）', () => {
    const whitelist = JSON.parse(read(WHITELIST))
    assert.ok(Array.isArray(whitelist.namingConflictNames))
    const actual = conflicts().map(item => item.name)
    assert.deepEqual(actual, whitelist.namingConflictNames.slice().sort())
  })

  test('② 登记项都有真实多份字面量定义，且不得洗白域级 SSOT 漂移', () => {
    const whitelist = JSON.parse(read(WHITELIST))
    for (const item of conflicts()) {
      assert.ok(item.variants.length >= 2, `${item.name} 没有真实的多份字面量定义`)
    }
    for (const name of SSOT_SENTINELS) {
      assert.equal(
        whitelist.namingConflictNames.includes(name),
        false,
        `${name} 是域级 SSOT，禁止登记为可接受的同名不同值`
      )
    }
  })
})
